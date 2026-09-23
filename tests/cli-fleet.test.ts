import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FX = join(import.meta.dir, "fixtures");
const FLEET_FX = join(FX, "fleet");
const temp = mkdtempSync(join(tmpdir(), "token-scope-fleet-"));
const opencodeDb = join(temp, "opencode.db");
const partialOrcaFixture = join(temp, "orca-partial-terminals.json");

type OllaServerName = "matched" | "ambiguous" | "partial" | "unavailable";

const servers = {} as Record<OllaServerName, ReturnType<typeof Bun.serve>>;

function startOllaServer(mode: OllaServerName): ReturnType<typeof Bun.serve> {
  const bodies: Record<string, string> = {
    "/internal/status": readFileSync(join(FX, "olla", "status.json"), "utf8"),
    "/internal/status/endpoints": readFileSync(join(FX, "olla", "endpoints.json"), "utf8"),
    "/internal/status/models": readFileSync(join(FX, "olla", "models.json"), "utf8"),
    "/internal/stats/models?include_endpoints=true&include_summary=true": readFileSync(join(FX, "olla", "model-stats.json"), "utf8"),
    "/internal/metrics": readFileSync(join(FX, "olla", "metrics.prom"), "utf8"),
  };
  if (mode === "ambiguous") {
    const endpoints = JSON.parse(bodies["/internal/status/endpoints"]!);
    endpoints.endpoints[1].name = endpoints.endpoints[0].name;
    bodies["/internal/status/endpoints"] = JSON.stringify(endpoints);
  }
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      if (mode === "unavailable") return new Response("", { status: 503 });
      if (mode === "partial" && path === "/internal/status") {
        return new Response("", { status: 503 });
      }
      const body = bodies[path];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    },
  });
}

beforeAll(() => {
  chmodSync(join(FLEET_FX, "bin", "orca"), 0o755);
  const partialOrca = JSON.parse(readFileSync(join(FLEET_FX, "orca-no-correlation.json"), "utf8"));
  partialOrca.terminals.result.totalCount += 1;
  partialOrca.terminals.result.truncated = true;
  partialOrca.terminals.result.hostScope = {
    hostIds: ["local"],
    omittedHostIds: ["ssh:gpu-box"],
  };
  writeFileSync(partialOrcaFixture, JSON.stringify(partialOrca));
  const db = new Database(opencodeDb);
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
  db.query("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
    "opencode-request",
    "opencode-session",
    JSON.stringify({
      role: "assistant",
      modelID: "kimi-k3",
      providerID: "opencode",
      cost: 0.05,
      tokens: { input: 44, output: 11, cache: { read: 3, write: 0 }, reasoning: 2 },
      time: {
        created: Date.parse("2026-09-22T14:02:45.000Z"),
        completed: Date.parse("2026-09-22T14:02:46.250Z"),
      },
    }),
  );
  db.close();

  servers.matched = startOllaServer("matched");
  servers.ambiguous = startOllaServer("ambiguous");
  servers.partial = startOllaServer("partial");
  servers.unavailable = startOllaServer("unavailable");
});

afterAll(() => {
  for (const server of Object.values(servers)) server.stop(true);
  rmSync(temp, { recursive: true, force: true });
});

async function runFleet(options: {
  json?: boolean;
  server?: OllaServerName;
  routes?: string;
  collectedAt?: string;
  promptOriginHost?: string | null;
  since?: string;
  claudeRoot?: string;
  ledger?: string;
  orcaFixture?: string;
  opencodeDb?: string;
} = {}) {
  const json = options.json ?? true;
  const server = servers[options.server ?? "matched"];
  const child = Bun.spawn([
    "bun", CLI, "--fleet", "--since", options.since ?? "10000d", ...(json ? ["--json"] : []),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${join(FLEET_FX, "bin")}:${process.env.PATH ?? ""}`,
      TOKEN_SCOPE_CLAUDE_ROOT: options.claudeRoot ?? join(FLEET_FX, "claude-root"),
      TOKEN_SCOPE_CODEX_HOME: join(FLEET_FX, "codex-home"),
      TOKEN_SCOPE_LEDGER: join(FLEET_FX, options.ledger ?? "ledger.jsonl"),
      TOKEN_SCOPE_GEMINI_ROOT: join(FLEET_FX, "gemini-root"),
      TOKEN_SCOPE_OPENCODE_DB: options.opencodeDb ?? opencodeDb,
      TOKEN_SCOPE_PROMPT_ORIGIN_HOST:
        options.promptOriginHost === undefined ? "origin-mac" : options.promptOriginHost ?? "",
      TOKEN_SCOPE_ORCA_FIXTURE: options.orcaFixture === "orca-partial-terminals.json"
        ? partialOrcaFixture
        : join(FLEET_FX, options.orcaFixture ?? "orca.json"),
      TOKEN_SCOPE_OLLA_URL: `http://127.0.0.1:${server.port}`,
      TOKEN_SCOPE_OLLA_ROUTES: join(FLEET_FX, options.routes ?? "olla-routes.json"),
      TOKEN_SCOPE_FLEET_COLLECTED_AT: options.collectedAt ?? "2026-09-22T14:05:01.000Z",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

describe("--fleet production CLI path", () => {
  it("joins fixture usage, Orca placement, and Olla telemetry deterministically", async () => {
    const first = await runFleet();
    const second = await runFleet();
    expect(first).toEqual(second);
    expect(first.code).toBe(0);
    expect(first.err).toBe("");

    const report = JSON.parse(first.out);
    expect(report.schema_version).toBe("1.0");
    expect(report.rows).toHaveLength(5);
    expect(report.rows.every((row: any) => /^[^:]+:opaque:[a-f0-9]{64}$/.test(row.event_id)))
      .toBe(true);
    for (const sourceIdentity of [
      "claude-request",
      "codex-session",
      "opencode-request",
      "gemini-request",
      "author:91",
    ]) {
      expect(report.rows.every((row: any) => !row.event_id.includes(sourceIdentity))).toBe(true);
    }
    const rows = Object.fromEntries(report.rows.map((row: any) => [row.harness, row]));

    expect(rows.claude).toMatchObject({
      prompt_origin_host: "origin-mac",
      execution_host: "orca:ssh:gpu-box",
      placement_state: "matched",
      route_state: "provider",
      billing_route: "subscription",
      cash_charge_usd: null,
    });
    expect(rows.codex).toMatchObject({
      execution_host: "orca:ssh:gpu-box",
      placement_state: "matched",
      session_id: "codex:codex-session",
      billing_route: "unknown",
    });
    expect(rows.opencode).toMatchObject({
      execution_host: "orca:local",
      placement_state: "matched",
      request_id: "opencode:opencode-request",
      billing_route: "metered",
      cash_charge_usd: 0.05,
    });
    expect(rows["gemini-cli"]).toMatchObject({
      execution_host: "orca:local",
      placement_state: "matched",
      request_id: "gemini-cli:gemini-request",
      session_id: "gemini-cli:gemini-session",
      provider: "google",
      billing_route: "unknown",
    });
    expect(rows["ollama-claude"]).toMatchObject({
      execution_host: "orca:ssh:gpu-box",
      placement_state: "matched",
      run_id: "ollama-agent:author%3A91",
      router_host: "127.0.0.1",
      backend_host: "ml1",
      backend: "vllm",
      billing_route: "local",
      route_state: "matched",
      total_latency: { value: 110, unit: "ms", scope: "aggregate" },
      cash_charge_usd: null,
    });
  });

  it("renders every requested operational field with explicit unknown and aggregate markers", async () => {
    const result = await runFleet({ json: false, promptOriginHost: null });
    expect(result.code).toBe(0);
    for (const label of [
      "prompt origin:", "agent execution host:", "router host:", "backend host:",
      "backend:", "harness:", "provider:", "model:", "request identity:",
      "run identity:", "session identity:", "status:", "billing route:",
      "cash charge USD:", "input tokens:", "output tokens:", "TTFT:",
      "decode TPS:", "total latency:", "placement state:", "route state:", "provenance:",
    ]) {
      expect(result.out, label).toContain(label);
    }
    expect(result.out).toContain("prompt origin: unknown");
    expect(result.out).toContain("TTFT: unknown");
    expect(result.out).toContain("total latency: 110ms aggregate");
    expect(result.out).toContain("total latency: 1250ms request");
  });

  it("keeps unrelated Orca terminals unmatched despite matching harness and time", async () => {
    const result = await runFleet({ orcaFixture: "orca-no-correlation.json" });
    const report = JSON.parse(result.out);
    expect(report.rows.every((row: any) => row.placement_state === "unmatched")).toBe(true);
    expect(report.rows.every((row: any) => row.execution_host === null)).toBe(true);
  });

  it("does not claim unmatched placement when the terminal listing is partial", async () => {
    const result = await runFleet({ orcaFixture: "orca-partial-terminals.json" });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.rows.every((row: any) => row.placement_state === "partial")).toBe(true);
    expect(report.rows.every((row: any) => row.execution_host === null)).toBe(true);
  });

  it("surfaces unmatched, ambiguous, stale, partial, and unavailable Olla routes", async () => {
    const cases: Array<{
      name: string;
      options: Parameters<typeof runFleet>[0];
      state: string;
    }> = [
      { name: "unmatched", options: { routes: "olla-routes-empty.json" }, state: "unmatched" },
      {
        name: "ambiguous",
        options: { server: "ambiguous", routes: "olla-routes-ambiguous.json" },
        state: "ambiguous",
      },
      {
        name: "stale",
        options: { collectedAt: "2026-09-22T14:07:00.000Z" },
        state: "stale",
      },
      { name: "partial", options: { server: "partial" }, state: "partial" },
      { name: "unavailable", options: { server: "unavailable" }, state: "unavailable" },
    ];
    for (const testCase of cases) {
      const result = await runFleet(testCase.options);
      expect(result.code, testCase.name).toBe(0);
      const report = JSON.parse(result.out);
      const local = report.rows.find((row: any) => row.harness === "ollama-claude");
      expect(local?.route_state, testCase.name).toBe(testCase.state);
    }
  });

  it("anchors the --since boundary and provenance to the same fixed evaluation time", async () => {
    const result = await runFleet({
      since: "1h",
      claudeRoot: join(FLEET_FX, "claude-boundary-root"),
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    const boundaryRows = report.rows.filter((row: any) => row.harness === "claude");
    expect(boundaryRows).toHaveLength(1);
    expect(boundaryRows[0]).toMatchObject({
      timestamp: "2026-09-22T13:05:01.000Z",
      request_id: "claude:boundary-included",
    });
    expect(boundaryRows[0].provenance[0].collected_at).toBe("2026-09-22T14:05:01.000Z");
  });

  it("keeps unknown origin and private route input out of output", async () => {
    const result = await runFleet({
      routes: "olla-routes-private.json",
      promptOriginHost: null,
    });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("route-secret");
    const report = JSON.parse(result.out);
    expect(report.rows.every((row: any) => row.prompt_origin_host === null)).toBe(true);
    const local = report.rows.find((row: any) => row.harness === "ollama-claude");
    expect(local).toMatchObject({ route_state: "unavailable", request_id: null });
  });

  it("renders credential-like provider correlations as unknown without leaking the secret", async () => {
    const options = {
      ledger: "ledger-private-correlation.jsonl",
      routes: "olla-routes-empty.json",
    };
    const jsonResult = await runFleet(options);
    expect(jsonResult.code).toBe(0);
    expect(jsonResult.out).not.toContain("audit-secret");
    const local = JSON.parse(jsonResult.out).rows.find((row: any) => row.harness === "ollama-claude");
    expect(local).toMatchObject({ run_id: null, session_id: null });

    const textResult = await runFleet({ ...options, json: false });
    expect(textResult.code).toBe(0);
    expect(textResult.out).not.toContain("audit-secret");
    expect(textResult.out).toContain("run identity: unknown");
    expect(textResult.out).toContain("session identity: unknown");
  });

  it("renders adversarial dynamic fleet values as null or unknown without leaking them", async () => {
    const privateDbPath = join(temp, "private-opencode.db");
    const privateDb = new Database(privateDbPath);
    privateDb.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    privateDb.query("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
      "glpat-private-request",
      "session\ncontrol",
      JSON.stringify({
        role: "assistant",
        modelID: "glpat-private-model",
        providerID: "glpat-private-provider",
        tokens: { input: 3, output: 2 },
        time: { created: Date.parse("2026-09-22T14:02:45.000Z") },
      }),
    );
    privateDb.close();

    const result = await runFleet({
      opencodeDb: privateDbPath,
      promptOriginHost: "origin\ncontrol",
      orcaFixture: "orca-no-correlation.json",
    });
    expect(result.code).toBe(0);
    for (const rejected of [
      "glpat-private-request",
      "glpat-private-model",
      "glpat-private-provider",
      "session\\ncontrol",
      "origin\\ncontrol",
    ]) {
      expect(result.out).not.toContain(rejected);
    }
    const row = JSON.parse(result.out).rows.find((candidate: any) => candidate.harness === "opencode");
    expect(row).toMatchObject({
      prompt_origin_host: null,
      provider: "unknown",
      model: null,
      request_id: null,
      session_id: null,
      placement_state: "unmatched",
    });
    expect(row.event_id).toMatch(/^opencode:opaque:[a-f0-9]{64}$/);
  });

  it("rejects secret formats and C0/C1 controls across JSON, text, and event IDs", async () => {
    const unsafeValues = [
      "AIzaSyD-auditGoogleKey0123456789012345",
      "xox" + "b-123456789012-auditSlackToken",
      "xoxp-123456789012-auditSlackToken",
      "xoxa-123456789012-auditSlackToken",
      "xapp-1-A0123456789-auditSlackAppToken",
      "npm_0123456789abcdef0123456789abcdef0123",
      "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhdWRpdCJ9.audit_signature_value",
      "control\u0007value",
      "control\u0085value",
      "control\u009fvalue",
    ];
    const privateDbPath = join(temp, "private-formats-opencode.db");
    const privateDb = new Database(privateDbPath);
    privateDb.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    for (const [index, unsafe] of unsafeValues.entries()) {
      privateDb.query("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
        unsafe,
        unsafe,
        JSON.stringify({
          role: "assistant",
          modelID: unsafe,
          providerID: unsafe,
          tokens: { input: 1, output: 1 },
          time: { created: Date.parse("2026-09-22T14:02:45.000Z") + index },
        }),
      );
    }
    privateDb.close();

    const jsonResult = await runFleet({
      opencodeDb: privateDbPath,
      orcaFixture: "orca-no-correlation.json",
    });
    const textResult = await runFleet({
      json: false,
      opencodeDb: privateDbPath,
      orcaFixture: "orca-no-correlation.json",
    });
    expect(jsonResult.code).toBe(0);
    expect(textResult.code).toBe(0);
    const rows = JSON.parse(jsonResult.out).rows.filter((row: any) => row.harness === "opencode");
    expect(rows).toHaveLength(unsafeValues.length);
    expect(new Set(rows.map((row: any) => row.event_id)).size).toBe(unsafeValues.length);
    expect(rows.every((row: any) => /^opencode:opaque:[a-f0-9]{64}$/.test(row.event_id))).toBe(true);
    expect(rows.every((row: any) =>
      row.request_id === null
      && row.session_id === null
      && row.provider === "unknown"
      && row.model === null
    )).toBe(true);
    for (const unsafe of unsafeValues) {
      const escaped = JSON.stringify(unsafe).slice(1, -1);
      expect(jsonResult.out).not.toContain(unsafe);
      expect(jsonResult.out).not.toContain(escaped);
      expect(textResult.out).not.toContain(unsafe);
      expect(textResult.out).not.toContain(escaped);
      expect(rows.every((row: any) => !row.event_id.includes(unsafe))).toBe(true);
    }
  });

  it("keeps distinct overlength provider IDs as distinct opaque CLI events", async () => {
    const prefix = "z".repeat(256);
    const longIds = [`${prefix}a`, `${prefix}b`];
    const privateDbPath = join(temp, "overlength-opencode.db");
    const privateDb = new Database(privateDbPath);
    privateDb.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    for (const [index, identity] of longIds.entries()) {
      privateDb.query("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
        identity,
        identity,
        JSON.stringify({
          role: "assistant",
          modelID: "safe-model",
          providerID: "safe-provider",
          tokens: { input: 1, output: 1 },
          time: { created: Date.parse("2026-09-22T14:02:45.000Z") + index },
        }),
      );
    }
    privateDb.close();

    const result = await runFleet({
      opencodeDb: privateDbPath,
      orcaFixture: "orca-no-correlation.json",
    });
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.out).rows.filter((row: any) => row.harness === "opencode");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row: any) => row.event_id)).size).toBe(2);
    expect(rows.every((row: any) => /^opencode:opaque:[a-f0-9]{64}$/.test(row.event_id))).toBe(true);
    expect(rows.every((row: any) => row.request_id === null && row.session_id === null)).toBe(true);
  });
});

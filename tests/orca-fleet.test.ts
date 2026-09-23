import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseFleetRecord } from "@/fleet-contract";
import {
  ORCA_READ_ONLY_COMMANDS,
  collectOrcaPlacement,
  type OrcaCommandResult,
  type OrcaCommandRunner,
} from "@/fleet/orca";

const FX = join(import.meta.dir, "fixtures", "orca");
const COLLECTED_AT = "2026-09-23T04:00:00.000Z";

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FX, name), "utf8"));
}

function result(value: unknown): OrcaCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function fixtureRunner(source: any, overrides: Record<string, OrcaCommandResult | Error> = {}): {
  runner: OrcaCommandRunner;
  calls: string[][];
  executables: string[];
} {
  const byCommand: Record<string, OrcaCommandResult> = {
    "status --json": result(source.status),
    "host list --json": result(source.hosts),
    "worktree ps --json": result(source.worktrees),
    "terminal list --json": result(source.terminals),
  };
  const calls: string[][] = [];
  const executables: string[] = [];
  return {
    calls,
    executables,
    runner: async (executable, args) => {
      executables.push(executable);
      calls.push([...args]);
      const key = args.join(" ");
      const override = overrides[key];
      if (override instanceof Error) throw override;
      return override ?? byCommand[key]!;
    },
  };
}

describe("Orca fleet placement adapter", () => {
  it("ingests a local multi-agent session without retaining prompts or scrollback", async () => {
    const source = fixture("local.json");
    const { runner, calls } = fixtureRunner(source);
    const collected = await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner });

    expect(calls).toEqual(ORCA_READ_ONLY_COMMANDS.map((args) => [...args]));
    expect(collected.records).toHaveLength(1);
    const record = collected.records[0]!;
    expect(parseFleetRecord(record)).toEqual(record);
    expect(record).toMatchObject({
      session_id: null,
      prompt_origin_host: null,
      execution_host: "orca:local",
      harness: "opencode",
      provider: "orca",
      timestamp: COLLECTED_AT,
      status: "ok",
    });
    expect(collected.metadata[record.record_id]).toMatchObject({
      terminalHandle: "term-local",
      worktreeId: "orca:repo-token::/Users/alice/token-scope",
      agentType: "opencode",
      placement: "local",
      observedAt: COLLECTED_AT,
    });
    const serialized = JSON.stringify(collected);
    expect(serialized).not.toContain("PRIVATE PROMPT");
    expect(serialized).not.toContain("PRIVATE TERMINAL SCROLLBACK");
    expect(serialized).not.toContain("private.txt");
  });

  it("retains local and SSH sessions while marking omitted paired-runtime coverage partial", async () => {
    const source = fixture("ssh.json");
    const { runner, calls } = fixtureRunner(source);
    const collected = await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner });

    expect(collected.records).toHaveLength(3);
    expect(collected.records.every((record) => record.session_id === null)).toBe(true);
    const codex = collected.records.find((record) => record.harness === "codex")!;
    const claude = collected.records.find((record) => record.harness === "claude")!;
    const gemini = collected.records.find((record) => record.harness === "gemini")!;
    expect(codex.execution_host).toBe("orca:ssh:gpu-box");
    expect(codex.prompt_origin_host).toBeNull();
    expect(claude.execution_host).toBe("orca:ssh:gpu-box");
    expect(claude.prompt_origin_host).toBeNull();
    expect(gemini.execution_host).toBe("orca:local");
    expect(collected.metadata[gemini.record_id]?.placement).toBe("local");
    expect(collected.metadata[codex.record_id]?.placement).toBe("ssh");
    expect(collected.records.every((record) => record.status === "partial")).toBe(true);
    expect(calls.some((args) => args.includes("--environment"))).toBe(false);
    expect(collected.hosts["orca:ssh:gpu-box"]).toMatchObject({
      sourceId: "ssh:gpu-box",
      kind: "ssh",
      name: "gpu box",
      platform: "linux",
    });
    expect(collected.hosts["orca:runtime:build-mac"]).toMatchObject({
      sourceId: "runtime:build-mac",
      kind: "runtime",
      name: "Build Mac",
    });
    expect(collected.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "orca worktree ps --json", state: "partial", reason: "partial_records" }),
      expect.objectContaining({ command: "orca terminal list --json", state: "partial", reason: "partial_records" }),
    ]));
  });

  it("reports a missing CLI without attempting any fallback command", async () => {
    const calls: string[][] = [];
    const missingFixture = fixture("missing-cli.json");
    const missing = Object.assign(new Error(missingFixture.message), { code: missingFixture.code });
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: async (_executable, args) => {
        calls.push([...args]);
        throw missing;
      },
    });

    expect(calls).toEqual([["status", "--json"]]);
    expect(collected.records).toEqual([]);
    expect(collected.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "orca status --json", state: "unavailable", reason: "missing_cli" }),
    ]));
  });

  it("does not let callers mutate the approved command boundary", async () => {
    const commands = ORCA_READ_ONLY_COMMANDS as unknown as string[][];
    const original = commands[0]![0]!;
    let mutationError: unknown = null;
    const source = fixture("local.json");
    const { runner, calls } = fixtureRunner(source);
    try {
      commands[0]![0] = "open";
    } catch (error) {
      mutationError = error;
    }
    try {
      await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner });
    } finally {
      if (commands[0]![0] !== original) commands[0]![0] = original;
    }

    expect(mutationError).toBeInstanceOf(TypeError);
    expect(calls).toEqual(ORCA_READ_ONLY_COMMANDS.map((args) => [...args]));
    expect(calls[0]).toEqual(["status", "--json"]);
  });

  it("does not let callers replace the Orca executable", async () => {
    const source = fixture("local.json");
    const { runner, executables } = fixtureRunner(source);
    await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner,
      executable: "orca open --json",
    });

    expect(executables).toEqual(["orca", "orca", "orca", "orca"]);
  });

  it("reports an unavailable runtime and an unsupported version explicitly", async () => {
    const unavailableSource = fixture("local.json");
    unavailableSource.status.result.runtime = {
      state: "not_running",
      reachable: false,
      runtimeId: null,
      appVersion: "1.4.162",
    };
    const unavailable = fixtureRunner(unavailableSource);
    const unavailableResult = await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner: unavailable.runner });
    expect(unavailable.calls).toEqual([["status", "--json"]]);
    expect(unavailableResult.sources[0]).toMatchObject({ state: "unavailable", reason: "runtime_unavailable" });

    const unsupported = fixtureRunner({ status: fixture("unsupported.json") });
    const unsupportedResult = await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner: unsupported.runner });
    expect(unsupported.calls).toEqual([["status", "--json"]]);
    expect(unsupportedResult.sources[0]).toMatchObject({ state: "unavailable", reason: "unsupported_version" });
  });

  it("keeps partial records explicit when host identity or source coverage is missing", async () => {
    const source = fixture("local.json");
    delete source.terminals.result.terminals[0].executionHostId;
    delete source.terminals.result.hostScope;
    source.terminals.result.truncated = true;
    const { runner } = fixtureRunner(source, {
      "worktree ps --json": { exitCode: 1, stdout: "", stderr: "runtime error" },
    });
    const collected = await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner });

    expect(collected.records[0]).toMatchObject({
      execution_host: null,
      prompt_origin_host: null,
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "orca worktree ps --json", state: "unavailable", reason: "command_failed" }),
      expect.objectContaining({ command: "orca terminal list --json", state: "partial", reason: "partial_records" }),
    ]));
  });

  for (const [fixtureName, caseName] of [
    ["omitted-hosts.json", "omitted hosts"],
    ["total-count-mismatch.json", "a totalCount mismatch"],
    ["malformed-host-ids.json", "a malformed hostIds entry"],
  ] as const) {
    it(`marks terminal source and records partial for ${caseName}`, async () => {
      const source = fixture("local.json");
      source.terminals = fixture(fixtureName);
      const collected = await collectOrcaPlacement({
        collectedAt: COLLECTED_AT,
        runner: fixtureRunner(source).runner,
      });

      expect(collected.records[0]).toMatchObject({
        status: "partial",
        provenance: { completeness: "partial" },
      });
      expect(collected.sources).toContainEqual(expect.objectContaining({
        command: "orca terminal list --json",
        state: "partial",
        reason: "partial_records",
        provenance: expect.objectContaining({ completeness: "partial" }),
      }));
    });
  }

  it("rejects credential-like retained identifiers without leaking them", async () => {
    const source = fixture("local.json");
    source.terminals = fixture("private-terminal-handle.json");
    const { runner } = fixtureRunner(source);
    const collected = await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner });

    expect(collected.records).toEqual([]);
    expect(collected.metadata).toEqual({});
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca terminal list --json",
      state: "partial",
      reason: "privacy",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
    expect(JSON.stringify(collected)).not.toContain("leaked-secret");
  });

  it("normalizes control characters before rejecting credential-like identifiers", async () => {
    const source = fixture("local.json");
    source.terminals = fixture("control-obfuscated-terminal-handle.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records).toEqual([]);
    expect(collected.metadata).toEqual({});
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca terminal list --json",
      state: "partial",
      reason: "privacy",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
    expect(JSON.stringify(collected)).not.toContain("leaked-secret");
  });

  it("marks terminal rows outside the authoritative host scope partial", async () => {
    const source = fixture("ssh.json");
    source.terminals = fixture("out-of-scope-terminal.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records[0]).toMatchObject({
      execution_host: "orca:ssh:gpu-box",
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca terminal list --json",
      state: "partial",
      reason: "partial_records",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
  });

  it("rejects worktree rows outside the authoritative host scope", async () => {
    const source = fixture("local.json");
    source.worktrees = fixture("out-of-scope-worktree.json");
    delete source.terminals.result.terminals[0].agentIdentity;
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records[0]).toMatchObject({
      harness: null,
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca worktree ps --json",
      state: "partial",
      reason: "partial_records",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
  });

  it("rejects malformed execution-host separators and percent encoding", async () => {
    const source = fixture("malformed-execution-hosts.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records).toHaveLength(2);
    expect(collected.records.every((record) => record.execution_host === null)).toBe(true);
    expect(collected.records.every((record) => record.status === "partial")).toBe(true);
    expect(Object.values(collected.metadata).every((metadata) => metadata.placement === "unknown")).toBe(true);
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca terminal list --json",
      state: "partial",
      reason: "partial_records",
    }));
  });

  it("accepts canonically percent-encoded execution-host identities", async () => {
    const source = fixture("encoded-execution-host.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records).toHaveLength(1);
    expect(collected.records[0]).toMatchObject({
      execution_host: "orca:ssh:gpu%20box",
      status: "ok",
      provenance: { completeness: "complete" },
    });
  });

  it("rejects recognizable raw tokens in persisted host metadata", async () => {
    const source = fixture("local.json");
    source.hosts = fixture("private-token-host.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.hosts).toEqual({});
    expect(collected.records[0]).toMatchObject({ status: "partial" });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca host list --json",
      state: "partial",
      reason: "privacy",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
    expect(JSON.stringify(collected)).not.toContain("ghp_");
  });

  it("keeps execution-host identity stable across Orca runtime restarts", async () => {
    const source = fixture("local.json");
    const restart = fixture("restart.json");
    source.status = restart.before;
    const before = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });
    source.status = restart.after;
    const after = await collectOrcaPlacement({
      collectedAt: "2026-09-23T04:05:00.000Z",
      runner: fixtureRunner(source).runner,
    });

    expect(before.runtime.id).not.toBe(after.runtime.id);
    expect(before.records[0]?.execution_host).toBe("orca:local");
    expect(after.records[0]?.execution_host).toBe("orca:local");
    expect(Object.keys(before.hosts)).toEqual(["orca:local"]);
    expect(Object.keys(after.hosts)).toEqual(["orca:local"]);
  });

  it("scopes worktree joins and terminal identity by execution host", async () => {
    const collision = fixture("worktree-collision.json");
    const source = {
      status: collision.status,
      hosts: collision.hosts,
      ...collision.crossHost,
    };
    source.terminals.result.terminals[0].handle = "term-shared";
    source.terminals.result.terminals.push({
      ...source.terminals.result.terminals[0],
      executionHostId: "ssh:gpu-box",
    });
    source.terminals.result.totalCount = 2;
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records).toHaveLength(2);
    expect(collected.records).toContainEqual(expect.objectContaining({
      execution_host: "orca:local",
      harness: "codex",
      status: "ok",
    }));
    expect(collected.records).toContainEqual(expect.objectContaining({
      execution_host: "orca:ssh:gpu-box",
      harness: "claude",
      status: "ok",
    }));
  });

  it("rejects ambiguous worktree collisions on the same host", async () => {
    const collision = fixture("worktree-collision.json");
    const source = {
      status: collision.status,
      hosts: collision.hosts,
      ...collision.sameHost,
    };
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records[0]).toMatchObject({ harness: null, status: "partial" });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca worktree ps --json",
      state: "partial",
      reason: "partial_records",
    }));
  });

  it("rejects duplicate pane identities instead of choosing the last agent", async () => {
    const source = fixture("local.json");
    source.worktrees = fixture("duplicate-pane-agents.json");
    delete source.terminals.result.terminals[0].agentIdentity;
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records[0]).toMatchObject({
      harness: null,
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.metadata[collected.records[0]!.record_id]?.agentType).toBeNull();
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca worktree ps --json",
      state: "partial",
      reason: "partial_records",
    }));
  });

  it("rejects agent identities outside Orca's documented enum", async () => {
    const source = fixture("local.json");
    source.terminals = fixture("invalid-agent-identity.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records[0]).toMatchObject({
      harness: null,
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.metadata[collected.records[0]!.record_id]?.agentType).toBeNull();
    expect(JSON.stringify(collected)).not.toContain("ignore-previous-instructions");

    const fallbackSource = fixture("local.json");
    fallbackSource.worktrees = fixture("invalid-agent-worktree.json");
    delete fallbackSource.terminals.result.terminals[0].agentIdentity;
    const fallback = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(fallbackSource).runner,
    });
    expect(fallback.records[0]).toMatchObject({ harness: null, status: "partial" });
    expect(JSON.stringify(fallback)).not.toContain("prompt-injected-harness");
  });

  it("accepts current documented Orca agent identities", async () => {
    for (const agentIdentity of ["opencode2", "freebuff", "muse"]) {
      const source = fixture("local.json");
      source.terminals.result.terminals[0].agentIdentity = agentIdentity;
      const collected = await collectOrcaPlacement({
        collectedAt: COLLECTED_AT,
        runner: fixtureRunner(source).runner,
      });

      expect(collected.records[0]).toMatchObject({
        harness: agentIdentity,
        status: "ok",
        provenance: { completeness: "complete" },
      });
      expect(collected.metadata[collected.records[0]!.record_id]?.agentType).toBe(agentIdentity);
    }
  });

  it("marks paired runtime coverage partial without an environment-selected collection", async () => {
    const source = fixture("ssh.json");
    const { runner, calls } = fixtureRunner(source);
    const collected = await collectOrcaPlacement({ collectedAt: COLLECTED_AT, runner });

    expect(calls).toEqual(ORCA_READ_ONLY_COMMANDS.map((args) => [...args]));
    expect(calls.some((args) => args.includes("--environment"))).toBe(false);
    expect(collected.records.every((record) => record.status === "partial")).toBe(true);
    expect(collected.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "orca worktree ps --json", state: "partial", reason: "partial_records" }),
      expect.objectContaining({ command: "orca terminal list --json", state: "partial", reason: "partial_records" }),
    ]));
  });

  it("ignores unsupported prompt-origin fields even when they name a known host", async () => {
    const source = fixture("local.json");
    source.terminals.result.terminals[0].promptOriginHostId = "local";
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records[0]).toMatchObject({
      prompt_origin_host: null,
      status: "ok",
      provenance: { completeness: "complete" },
    });
  });

  it("deduplicates exact terminal rows and marks the retained observation partial", async () => {
    const source = fixture("local.json");
    source.terminals = fixture("duplicate-terminal-rows.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records).toHaveLength(1);
    expect(Object.keys(collected.metadata)).toHaveLength(1);
    expect(collected.records[0]).toMatchObject({
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca terminal list --json",
      state: "partial",
      reason: "partial_records",
    }));
  });

  it("removes attribution from duplicate terminal rows with conflicting agent identities", async () => {
    const source = fixture("local.json");
    source.terminals = fixture("conflicting-terminal-agents.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records).toHaveLength(1);
    expect(collected.records[0]).toMatchObject({
      harness: null,
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.metadata[collected.records[0]!.record_id]?.agentType).toBeNull();
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca terminal list --json",
      state: "partial",
      reason: "partial_records",
    }));
  });

  it("collapses conflicting placement rows for one runtime-scoped terminal handle", async () => {
    const source = fixture("local.json");
    source.terminals = fixture("conflicting-terminal-placement.json");
    const collected = await collectOrcaPlacement({
      collectedAt: COLLECTED_AT,
      runner: fixtureRunner(source).runner,
    });

    expect(collected.records).toHaveLength(1);
    expect(Object.keys(collected.metadata)).toHaveLength(1);
    expect(collected.records[0]).toMatchObject({
      execution_host: "orca:local",
      harness: null,
      status: "partial",
      provenance: { completeness: "partial" },
    });
    expect(collected.metadata[collected.records[0]!.record_id]).toMatchObject({
      terminalHandle: "term-local",
      worktreeId: null,
      agentType: null,
      placement: "local",
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      command: "orca terminal list --json",
      state: "partial",
      reason: "partial_records",
    }));
  });
});

import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeEvents } from "@/providers/claude";
import { codexEvents } from "@/providers/codex";
import { geminiCliEvents } from "@/providers/gemini-cli";
import { collectProviderEvents } from "@/providers";

const FX = join(import.meta.dir, "fixtures", "providers");
const GEMINI_SESSION = join(FX, "gemini-cli", "success", "tmp", "project-a", "chats", "session-success.jsonl");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const onlyGemini = (geminiRoot: string) => collectProviderEvents({
  claudeRoot: "/nonexistent",
  ledgerPath: "/nonexistent.jsonl",
  codexHome: "/nonexistent",
  opencodeDb: "/nonexistent.db",
  geminiRoot,
});

describe("claude and codex keep good files when one record is null", () => {
  it("claude: a `null` line does not drop the harness", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-claude-null-"));
    try {
      const proj = join(root, "projects", "p");
      mkdirSync(proj, { recursive: true });
      copyFileSync(join(FX, "claude-root", "projects", "-Users-x-proj", "t.jsonl"), join(proj, "good.jsonl"));
      writeFileSync(join(proj, "bad.jsonl"), "null\n");

      const { events, skipped, reasons } = claudeEvents(root);
      expect(events.length).toBeGreaterThan(0);
      expect(skipped).toBe(0);
      expect(reasons).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("codex: a `null` line does not drop the harness", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-codex-null-"));
    try {
      const sessions = join(root, ".codex", "sessions");
      mkdirSync(sessions, { recursive: true });
      copyFileSync(join(FX, "codex-rollout.jsonl"), join(sessions, "good.jsonl"));
      writeFileSync(join(sessions, "bad.jsonl"), "null\n");

      const { events, skipped, reasons } = codexEvents(root);
      expect(events.length).toBeGreaterThan(0);
      expect(skipped).toBe(0);
      expect(reasons).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gemini-cli partly-unreadable tree (#125)", () => {
  it.skipIf(isRoot)("an unreadable chats dir beside a readable session is partial/unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-mixed-dir-"));
    const locked = join(root, "tmp", "project-b", "chats");
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      mkdirSync(locked, { recursive: true });
      copyFileSync(GEMINI_SESSION, join(chats, "session-success.jsonl"));
      chmodSync(locked, 0);

      const gemini = geminiCliEvents(root);
      expect(gemini.events.length).toBeGreaterThan(0);
      expect(gemini.source.state).toBe("partial");
      expect(gemini.source.reason).toBe("unreadable");
      expect(gemini.reasons).toEqual(["unreadable"]);

      const collected = onlyGemini(root);
      expect(collected.partial["gemini-cli"]).toBeGreaterThanOrEqual(1);
      expect(collected.partialReasons?.["gemini-cli"]).toEqual(["unreadable"]);
    } finally {
      try { chmodSync(locked, 0o700); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)("an unreadable file beside a readable session is partial/unreadable on every platform", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-mixed-file-"));
    const secret = join(root, "tmp", "project-a", "chats", "secret.jsonl");
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      copyFileSync(GEMINI_SESSION, join(chats, "session-success.jsonl"));
      const other = readFileSync(GEMINI_SESSION, "utf8").replaceAll("session-success", "session-secret");
      writeFileSync(secret, other);
      chmodSync(secret, 0);

      const gemini = geminiCliEvents(root);
      expect(gemini.events.length).toBeGreaterThan(0);
      expect(gemini.source.state).toBe("partial");
      expect(gemini.reasons).toEqual(["unreadable"]);

      const collected = onlyGemini(root);
      expect(collected.partial["gemini-cli"]).toBe(1);
      expect(collected.partialReasons?.["gemini-cli"]).toEqual(["unreadable"]);
    } finally {
      try { chmodSync(secret, 0o600); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reasons are sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-sorted-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      writeFileSync(join(chats, "a.jsonl"), [
        JSON.stringify({ sessionId: "s-sorted", messages: [] }),
        "not-json",
      ].join("\n"));
      mkdirSync(join(root, "tmp", "project-b"), { recursive: true });
      writeFileSync(join(root, "tmp", "project-b", "chats"), "x");

      const { reasons } = geminiCliEvents(root);
      expect(reasons).toEqual([...reasons].sort());
      expect(reasons).toContain("malformed");
      expect(reasons).toContain("unsafe_path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("partialReasons describes partial sources only", () => {
  it("an unavailable gemini source has no partialReasons entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-gemini-root-file-"));
    try {
      const rootFile = join(dir, "gemini");
      writeFileSync(rootFile, "not a directory");
      const collected = onlyGemini(rootFile);
      expect(collected.unavailable).toContain("gemini-cli");
      expect(collected.partialReasons?.["gemini-cli"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("partialReasons names each harness's cause", () => {
  const collect = (over: Partial<Parameters<typeof collectProviderEvents>[0]>) => collectProviderEvents({
    claudeRoot: "/nonexistent",
    ledgerPath: "/nonexistent.jsonl",
    codexHome: "/nonexistent",
    opencodeDb: "/nonexistent.db",
    geminiRoot: "/nonexistent",
    ...over,
  });

  it.skipIf(isRoot)("claude: an unreadable transcript is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-claude-unreadable-"));
    const locked = join(root, "projects", "p", "locked.jsonl");
    try {
      mkdirSync(join(root, "projects", "p"), { recursive: true });
      copyFileSync(join(FX, "claude-root", "projects", "-Users-x-proj", "t.jsonl"), join(root, "projects", "p", "good.jsonl"));
      writeFileSync(locked, "{}\n");
      chmodSync(locked, 0);
      const collected = collect({ claudeRoot: root });
      expect(collected.partial["claude"]).toBe(1);
      expect(collected.partialReasons?.["claude"]).toEqual(["unreadable"]);
    } finally {
      try { chmodSync(locked, 0o600); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)("codex: an unreadable rollout is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-codex-unreadable-"));
    const locked = join(root, ".codex", "sessions", "locked.jsonl");
    try {
      mkdirSync(join(root, ".codex", "sessions"), { recursive: true });
      copyFileSync(join(FX, "codex-rollout.jsonl"), join(root, ".codex", "sessions", "good.jsonl"));
      writeFileSync(locked, "{}\n");
      chmodSync(locked, 0);
      const collected = collect({ codexHome: root });
      expect(collected.partial["codex"]).toBe(1);
      expect(collected.partialReasons?.["codex"]).toEqual(["unreadable"]);
    } finally {
      try { chmodSync(locked, 0o600); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ollama-route: skipped telemetry lines are malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-route-malformed-"));
    try {
      const telemetry = join(dir, "routing.jsonl");
      writeFileSync(telemetry, "not-json\n");
      const collected = collect({ ollamaRoutingTelemetry: telemetry });
      expect(collected.partial["ollama-route"]).toBe(1);
      expect(collected.partialReasons?.["ollama-route"]).toEqual(["malformed"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ollama: a ledger with content but no parseable runs is corrupt_store", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-ledger-corrupt-"));
    try {
      const ledger = join(dir, "runs.jsonl");
      writeFileSync(ledger, "not-json\nalso not json\n");
      const collected = collect({ ledgerPath: ledger });
      expect(collected.partial["ollama-claude"]).toBe(2);
      expect(collected.partialReasons?.["ollama-claude"]).toEqual(["corrupt_store"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeEvents } from "@/providers/claude";
import { codexEvents } from "@/providers/codex";

const FX = join(import.meta.dir, "fixtures", "providers");

describe("claude and codex keep good files when one record is null", () => {
  it("claude: a `null` line does not drop the harness", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-claude-null-"));
    try {
      const proj = join(root, "projects", "p");
      mkdirSync(proj, { recursive: true });
      copyFileSync(join(FX, "claude-root", "projects", "-Users-x-proj", "t.jsonl"), join(proj, "good.jsonl"));
      writeFileSync(join(proj, "bad.jsonl"), "null\n");

      const { events } = claudeEvents(root);
      expect(events.length).toBeGreaterThan(0);
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

      const { events } = codexEvents(root);
      expect(events.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

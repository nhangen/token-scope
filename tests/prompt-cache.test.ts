import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSnapshot,
  promptCacheLogPath,
  readSnapshots,
  reduceSession,
  sanitizePayload,
  summarizeNative,
  type PromptCacheSnapshot,
} from "@/prompt-cache";
import { renderCacheReport } from "@/reports/cache";
import { createReader } from "@/reader";

const full = {
  session_id: "sess-1",
  version: "2.1.301",
  transcript_path: "/secret/transcript.jsonl",
  cost: { total_cost_usd: 1 },
  prompt_cache: {
    warm: true, caching_observed: true, ttl: "1h", expires_at: 1738429200,
    requests: 14, misses: 2, expected_rebuilds: 1, hit_ratio: 0.91,
    cache_write_tokens: 352000, miss_recache_tokens: 310200, last_miss_at: 1738425230,
    last_miss_cause: { causes: ["tools_changed"], tools_added: 2, tools_removed: 0, prompt: "SECRET" },
    miss_causes: { tools_changed: 2 }, recache_tokens_if_cold: 45000, extra: "dropped",
  },
};

function snap(at: number, pc: Partial<PromptCacheSnapshot> = {}, id = "s1"): PromptCacheSnapshot {
  return { sessionId: id, capturedAt: at, scope: "main", ...pc };
}

function capture(fn: () => void): string {
  const old = console.log;
  let out = "";
  console.log = (...a: unknown[]) => { out += a.map(String).join(" ") + "\n"; };
  try { fn(); } finally { console.log = old; }
  return out;
}

describe("sanitizePayload", () => {
  it("keeps only allowlisted fields", () => {
    const s = sanitizePayload(full, 100)!;
    const json = JSON.stringify(s);
    expect(s.requests).toBe(14);
    expect(s.sessionHitRatio).toBe(0.91);
    expect(s.lastMissCause).toEqual({ causes: ["tools_changed"], toolsAdded: 2, toolsRemoved: 0 });
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("transcript");
    expect(json).not.toContain("dropped");
    expect(json).not.toContain("total_cost");
  });

  it("returns null for older clients without prompt_cache or session id", () => {
    expect(sanitizePayload({ session_id: "x", version: "2.1.200" }, 1)).toBeNull();
    expect(sanitizePayload({ prompt_cache: {} }, 1)).toBeNull();
    expect(sanitizePayload("nope", 1)).toBeNull();
  });

  it("leaves absent and invalid fields unknown, not zero", () => {
    const s = sanitizePayload({ session_id: "x", prompt_cache: { warm: false, misses: -3, hit_ratio: 7, requests: "9" } }, 1)!;
    expect(s.warm).toBe(false);
    expect(s.misses).toBeUndefined();
    expect(s.requests).toBeUndefined();
    expect(s.sessionHitRatio).toBeUndefined();
    expect(s.lastMissCause).toBeUndefined();
  });

  it("preserves explicit nulls and a null cause", () => {
    const s = sanitizePayload({ session_id: "x", prompt_cache: { hit_ratio: null, expires_at: null, last_miss_cause: null, recache_tokens_if_cold: null } }, 1)!;
    expect(s.sessionHitRatio).toBeNull();
    expect(s.expiresAt).toBeNull();
    expect(s.lastMissCause).toBeNull();
    expect(s.recacheTokensIfCold).toBeNull();
  });

  it("drops malformed cause names and an empty causes array", () => {
    const s = sanitizePayload({ session_id: "x", prompt_cache: { last_miss_cause: { causes: ["Bad Name!"] }, miss_causes: { "bad key": 1, ok_key: 2 } } }, 1)!;
    expect(s.lastMissCause).toBeUndefined();
    expect(s.missCauses).toEqual({ ok_key: 2 });
  });
});

describe("reduceSession", () => {
  it("does not inflate totals from repeated cumulative snapshots", () => {
    const row = reduceSession([
      snap(1, { requests: 5, misses: 1, cacheWriteTokens: 100 }),
      snap(2, { requests: 5, misses: 1, cacheWriteTokens: 100 }),
      snap(3, { requests: 9, misses: 2, cacheWriteTokens: 250, missCauses: { tools_changed: 2 } }),
    ]);
    expect(row.requests).toBe(9);
    expect(row.misses).toBe(2);
    expect(row.cacheWriteTokens).toBe(250);
    expect(row.segments).toBe(1);
    expect(row.missCauses).toEqual({ tools_changed: 2 });
  });

  it("treats a counter drop as a reset and counts both segments", () => {
    const row = reduceSession([
      snap(1, { requests: 10, misses: 3, sessionHitRatio: 0.9 }),
      snap(2, { requests: 2, misses: 0, sessionHitRatio: 0.5 }),
      snap(3, { requests: 4, misses: 1, sessionHitRatio: 0.6 }),
    ]);
    expect(row.segments).toBe(2);
    expect(row.requests).toBe(14);
    expect(row.misses).toBe(4);
    expect(row.sessionHitRatio).toBeNull();
  });

  it("keeps session hit ratio when there is one segment", () => {
    expect(reduceSession([snap(1, { requests: 3, sessionHitRatio: 0.8 })]).sessionHitRatio).toBe(0.8);
  });

  it("leaves a counter unknown when never reported", () => {
    const row = reduceSession([snap(1, { requests: 3 })]);
    expect(row.misses).toBeUndefined();
    expect(row.expectedRebuilds).toBeUndefined();
  });

  it("keeps expected rebuilds separate from diagnosed misses", () => {
    const row = reduceSession([snap(1, { requests: 8, misses: 0, expectedRebuilds: 2 })]);
    expect(row.misses).toBe(0);
    expect(row.expectedRebuilds).toBe(2);
  });

  it("does not let a later partial snapshot erase reported fields", () => {
    const row = reduceSession([snap(1, { requests: 4, misses: 1, lastMissAt: 50 }), snap(2, { requests: 5 })]);
    expect(row.misses).toBe(1);
    expect(row.lastMissAt).toBe(50);
  });
});

describe("summarizeNative", () => {
  it("sums across sessions, filters by window, and is labeled reported/main", () => {
    const out = summarizeNative(
      [
        snap(1000, { requests: 4, misses: 1 }, "a"),
        snap(2000, { requests: 6, misses: 2, missCauses: { likely_server_side: 2 } }, "b"),
        snap(2100, { requests: 6, misses: 2, missCauses: { likely_server_side: 2 } }, "b"),
      ],
      1500,
    );
    expect(out.sessions).toBe(1);
    expect(out.requests).toBe(6);
    expect(out.missCauses).toEqual({ likely_server_side: 2 });
    expect(out.provenance).toBe("reported");
    expect(out.scope).toBe("main");
  });

  it("reports null totals, not zero, when nothing was collected", () => {
    const out = summarizeNative([], 0);
    expect(out.sessions).toBe(0);
    expect(out.requests).toBeNull();
    expect(out.misses).toBeNull();
  });
});

describe("log persistence", () => {
  it("appends deduplicated allowlisted lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    try {
      const path = join(dir, "nested", "prompt-cache.jsonl");
      const a = sanitizePayload(full, 100)!;
      expect(appendSnapshot(path, a)).toBe(true);
      expect(appendSnapshot(path, { ...a, capturedAt: 200 })).toBe(false);
      expect(appendSnapshot(path, { ...a, capturedAt: 300, requests: 15 })).toBe(true);
      expect(readSnapshots(path)).toHaveLength(2);
      expect(readFileSync(path, "utf8")).not.toContain("transcript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed lines and honors the path override", () => {
    expect(promptCacheLogPath({ TOKEN_SCOPE_PROMPT_CACHE_LOG: "/x/y.jsonl" })).toBe("/x/y.jsonl");
    expect(promptCacheLogPath({ XDG_STATE_HOME: "/s", HOME: "/h" })).toBe("/s/token-scope/prompt-cache.jsonl");
    expect(readSnapshots("/nonexistent/none.jsonl")).toEqual([]);
  });
});

describe("cache report", () => {
  it("emits native_prompt_cache and labels existing misses inferred in JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    const path = join(dir, "pc.jsonl");
    const prev = process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"];
    try {
      appendSnapshot(path, sanitizePayload(full, Math.floor(Date.now() / 1000))!);
      process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = path;
      const reader = createReader();
      const out = capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: true, focus: "all" }));
      const json = JSON.parse(out);
      expect(json.native_prompt_cache.provenance).toBe("reported");
      expect(json.native_prompt_cache.misses).toBe(2);
      expect(json.miss_provenance).toBe("inferred");
      expect(json.summary.overall_cache_hit_pct).not.toBe(0.91);
      const text = capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: false, focus: "misses" }));
      expect(text).toContain("Claude Code Reported Cache Diagnostics");
      expect(text).toContain("tools_changed");
      expect(text).toContain("inferred from timing");
      reader.close();
    } finally {
      if (prev === undefined) delete process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"]; else process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows a setup hint when no snapshots exist", () => {
    const reader = createReader();
    const text = capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: false, focus: "misses" }));
    expect(text).toContain("No status-line snapshots");
    reader.close();
  });
});

describe("collector entry point", () => {
  async function run(stdin: string, log: string): Promise<number> {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "statusline", "collect.ts")], {
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TOKEN_SCOPE_PROMPT_CACHE_LOG: log },
    });
    expect((await new Response(proc.stdout).text())).toBe("");
    return await proc.exited;
  }

  it("persists a snapshot, prints nothing, and exits 0 on garbage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    try {
      const log = join(dir, "pc.jsonl");
      expect(await run(JSON.stringify(full), log)).toBe(0);
      expect(readSnapshots(log)).toHaveLength(1);
      expect(await run("not json", log)).toBe(0);
      expect(await run(JSON.stringify({ session_id: "old" }), log)).toBe(0);
      expect(readSnapshots(log)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

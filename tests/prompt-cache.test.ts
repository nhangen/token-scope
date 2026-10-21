import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSnapshot,
  promptCacheLogPath,
  readSnapshotLog,
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

  it("honors the path override and XDG fallback", () => {
    expect(promptCacheLogPath({ TOKEN_SCOPE_PROMPT_CACHE_LOG: "/x/y.jsonl" })).toBe("/x/y.jsonl");
    expect(promptCacheLogPath({ XDG_STATE_HOME: "/s", HOME: "/h" })).toBe("/s/token-scope/prompt-cache.jsonl");
    expect(promptCacheLogPath({ HOME: "/h" })).toBe("/h/.local/state/token-scope/prompt-cache.jsonl");
    const missing = readSnapshotLog("/nonexistent/none.jsonl");
    expect(missing).toEqual({ snapshots: [], exists: false, skippedLines: 0 });
  });

  it("rejects a last_miss_cause with non-numeric tool counts on read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    try {
      const path = join(dir, "pc.jsonl");
      writeFileSync(path, JSON.stringify({ sessionId: "s", capturedAt: 1, scope: "main", lastMissCause: { causes: ["tools_changed"], toolsAdded: "2" } }) + "\n");
      expect(readSnapshotLog(path).skippedLines).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips and counts malformed or wrongly typed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    try {
      const path = join(dir, "pc.jsonl");
      const good = JSON.stringify({ sessionId: "ok", capturedAt: 5, scope: "main", requests: 3 });
      writeFileSync(path, [
        "garbage", "null", '{"sessionId":"a"}',
        JSON.stringify({ sessionId: "s", capturedAt: 1, scope: "main", requests: "5" }),
        JSON.stringify({ sessionId: "s", capturedAt: 1, scope: "main", missCauses: "abc" }),
        JSON.stringify({ sessionId: "bad id!", capturedAt: 1, scope: "main" }),
        good, "",
      ].join("\n"));
      const log = readSnapshotLog(path);
      expect(log.snapshots.map((s) => s.sessionId)).toEqual(["ok"]);
      expect(log.skippedLines).toBe(6);
      expect(log.readError).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a directory at the log path as a read error, not an absent log", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    try {
      const log = readSnapshotLog(dir);
      expect(log.exists).toBe(true);
      expect(log.readError).toBe("EISDIR");
      expect(log.snapshots).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      expect(json.native_prompt_cache.rows[0].sessionHitRatio).toBe(0.91);
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

describe("sanitizer bounds", () => {
  const pc = (o: Record<string, unknown>) => sanitizePayload({ session_id: "x", prompt_cache: o }, 1)!;

  it("accepts the ratio endpoints and rejects values outside 0..1", () => {
    expect(pc({ hit_ratio: 0 }).sessionHitRatio).toBe(0);
    expect(pc({ hit_ratio: 1 }).sessionHitRatio).toBe(1);
    expect(pc({ hit_ratio: 1.01 }).sessionHitRatio).toBeUndefined();
  });

  it("keeps a negative system_char_delta and rejects an unknown ttl", () => {
    expect(pc({ last_miss_cause: { causes: ["system_prompt_changed"], system_char_delta: -120 } }).lastMissCause?.systemCharDelta).toBe(-120);
    expect(pc({ ttl: "2h" }).ttl).toBeUndefined();
  });

  it("rejects session ids over 128 chars or with unsafe characters", () => {
    expect(sanitizePayload({ session_id: "a".repeat(129), prompt_cache: {} }, 1)).toBeNull();
    expect(sanitizePayload({ session_id: "a\u001b[31m", prompt_cache: {} }, 1)).toBeNull();
  });

  it("caps the cause map at 16 entries", () => {
    const causes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, 1]));
    expect(Object.keys(pc({ miss_causes: causes }).missCauses!)).toHaveLength(16);
  });

  it("records the client version", () => {
    expect(sanitizePayload(full, 1)!.clientVersion).toBe("2.1.301");
  });
});

describe("report degradation", () => {
  it("renders n/a for absent counters in text output", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    const path = join(dir, "pc.jsonl");
    const prev = process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"];
    try {
      appendSnapshot(path, sanitizePayload({ session_id: "sparse", prompt_cache: { warm: true } }, Math.floor(Date.now() / 1000))!);
      process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = path;
      const reader = createReader();
      const text = capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: false, focus: "misses" }));
      expect(text).toContain("Diagnosed Misses");
      expect(text).toContain("n/a");
      reader.close();
    } finally {
      if (prev === undefined) delete process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"]; else process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the inferred report when the log path is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    const prev = process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"];
    try {
      process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = dir;
      const reader = createReader();
      const json = JSON.parse(capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: true, focus: "all" })));
      expect(json.native_prompt_cache.log.readError).toBe("EISDIR");
      expect(json.misses).toBeDefined();
      const text = capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: false, focus: "misses" }));
      expect(text).toContain("Collector log unreadable (EISDIR)");
      expect(text).toContain("Miss Classification");
      reader.close();
    } finally {
      if (prev === undefined) delete process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"]; else process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces an unreadable log even when there is no inferred data", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    const empty = mkdtempSync(join(tmpdir(), "ts-pc-empty-"));
    const prev = process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"];
    try {
      process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = dir;
      const reader = createReader({ source: "jsonl", projectsDirs: [empty] });
      const text = capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: false, focus: "misses" }));
      expect(text).toContain("Collector log unreadable (EISDIR)");
      reader.close();
    } finally {
      if (prev === undefined) delete process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"]; else process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = prev;
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("omits native_prompt_cache from --cache-sim JSON", () => {
    const reader = createReader();
    const json = JSON.parse(capture(() => renderCacheReport(reader, { since: 0, sinceStr: "all", limit: 10, json: true, focus: "sim" })));
    expect(json.native_prompt_cache).toBeUndefined();
    reader.close();
  });
});

describe("reduceSession edges", () => {
  it("is order-independent, resets on misses alone, and sums causes across segments", () => {
    const row = reduceSession([
      snap(3, { requests: 4, misses: 0, cacheWriteTokens: 40, missCauses: { b: 1 } }),
      snap(1, { requests: 6, misses: 3, cacheWriteTokens: 60, missCauses: { a: 3 } }),
    ]);
    expect(row.segments).toBe(2);
    expect(row.misses).toBe(3);
    expect(row.cacheWriteTokens).toBe(100);
    expect(row.missCauses).toEqual({ a: 3, b: 1 });
  });

  it("includes a session whose last snapshot is exactly at the window start", () => {
    expect(summarizeNative([snap(100, { requests: 1 })], 100).sessions).toBe(1);
    expect(summarizeNative([snap(99, { requests: 1 })], 100).sessions).toBe(0);
  });
});

describe("collector failure path", () => {
  it("exits 0 with empty stdout and names the error class on stderr when the log is unwritable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-pc-"));
    try {
      const blocker = join(dir, "file");
      writeFileSync(blocker, "x");
      const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "statusline", "collect.ts")], {
        stdin: new Blob([JSON.stringify(full)]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TOKEN_SCOPE_PROMPT_CACHE_LOG: join(blocker, "nested", "pc.jsonl") },
      });
      expect(await new Response(proc.stdout).text()).toBe("");
      expect(await new Response(proc.stderr).text()).toMatch(/not recorded \((ENOTDIR|EEXIST|ENOENT)\)/);
      expect(await proc.exited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

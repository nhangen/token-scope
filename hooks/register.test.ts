import { test, expect, describe } from "claude-code/testing";
import {
  label,
  parseTtl,
  resolveTtl,
  isOptedOut,
  isOverageFallback,
  register,
} from "./register";

// Prototype tests (must continue passing)
test("no request yet shows nothing", () => {
  expect(label(1000, undefined, undefined)).toBe(undefined);
});

test("warm counts down from the last request", () => {
  expect(label(90_000, 0, 97)).toBe("cache warm 58:30 · hit 97%");
});

test("cold after the hour", () => {
  expect(label(3_600_001, 0, 97)).toBe("cache cold");
});

describe("label formatting options", () => {
  test("warm without hit percentage", () => {
    expect(label(90_000, 0, undefined)).toBe("cache warm 58:30");
  });

  test("disabled caching (ttlMs = null) shows nothing", () => {
    expect(label(90_000, 0, 97, null)).toBe(undefined);
  });

  test("zero or negative ttlMs shows nothing", () => {
    expect(label(90_000, 0, 97, 0)).toBe(undefined);
    expect(label(90_000, 0, 97, -100)).toBe(undefined);
  });

  test("5m fallback countdown format with tag", () => {
    // 300s - 110s = 190s left => 3:10
    expect(label(110_000, 0, 0, 300_000, true)).toBe("cache warm 3:10 (5m) · hit 0%");
    expect(label(110_000, 0, undefined, 300_000, true)).toBe("cache warm 3:10 (5m)");
  });

  test("5m fallback cold after 5 minutes", () => {
    expect(label(300_001, 0, 0, 300_000, true)).toBe("cache cold");
  });
});

describe("TTL parsing and config resolution", () => {
  test("parseTtl handles units and numbers", () => {
    expect(parseTtl("5m")).toBe(300_000);
    expect(parseTtl("1h")).toBe(3_600_000);
    expect(parseTtl("300s")).toBe(300_000);
    expect(parseTtl("60000ms")).toBe(60_000);
    expect(parseTtl(300_000)).toBe(300_000);
    expect(parseTtl("invalid")).toBe(undefined);
    expect(parseTtl(null)).toBe(undefined);
  });

  test("DISABLE_PROMPT_CACHING returns null (show nothing)", () => {
    expect(resolveTtl({ DISABLE_PROMPT_CACHING: "1" })).toBe(null);
    expect(resolveTtl({ DISABLE_PROMPT_CACHING: "true" })).toBe(null);
  });

  test("FORCE_PROMPT_CACHING_5M returns 5 minutes", () => {
    expect(resolveTtl({ FORCE_PROMPT_CACHING_5M: "1" })).toBe(300_000);
  });

  test("CLAUDE_CODE_PROMPT_CACHE_TTL env var takes precedence", () => {
    expect(resolveTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })).toBe(300_000);
    expect(resolveTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" })).toBe(3_600_000);
  });

  test("promptCacheTtl from settings", () => {
    expect(resolveTtl({}, {}, { promptCacheTtl: "5m" })).toBe(300_000);
    expect(resolveTtl({}, {}, { promptCacheTtl: "1h" })).toBe(3_600_000);
  });

  test("promptCacheTtl from options", () => {
    expect(resolveTtl({}, { promptCacheTtl: "5m" })).toBe(300_000);
  });

  test("ENABLE_PROMPT_CACHING_1H returns 1 hour", () => {
    expect(resolveTtl({ ENABLE_PROMPT_CACHING_1H: "1" })).toBe(3_600_000);
  });

  test("defaults to 1 hour", () => {
    expect(resolveTtl({}, {}, {})).toBe(3_600_000);
  });
});

describe("Usage-overage fallback detection", () => {
  const ONE_HOUR = 3_600_000;

  test("gap under 5m does not trigger fallback", () => {
    // 4 minutes gap
    expect(isOverageFallback(240_000, ONE_HOUR, 0, 5000)).toBe(false);
  });

  test("gap beyond TTL does not trigger fallback (natural expiration)", () => {
    // 65 minutes gap
    expect(isOverageFallback(3_900_000, ONE_HOUR, 0, 5000)).toBe(false);
  });

  test("normal cache hit within gap does not trigger fallback", () => {
    // 10 minutes gap with healthy cache read
    expect(isOverageFallback(600_000, ONE_HOUR, 10_000, 0)).toBe(false);
  });

  test("near-zero read with large write triggers fallback", () => {
    // 10 minutes gap: 0 read and 5000 creation tokens
    expect(isOverageFallback(600_000, ONE_HOUR, 0, 5000)).toBe(true);
    // near-zero read (e.g. 50 tokens) and large write
    expect(isOverageFallback(600_000, ONE_HOUR, 50, 2000)).toBe(true);
  });

  test("tiny write without read does not trigger fallback", () => {
    expect(isOverageFallback(600_000, ONE_HOUR, 0, 50)).toBe(false);
  });
});

describe("Opt-out configuration", () => {
  test("opt-out via userConfig options", () => {
    expect(isOptedOut({ cacheTimer: false })).toBe(true);
    expect(isOptedOut({ cacheTimer: true })).toBe(false);
    expect(isOptedOut({})).toBe(false);
  });

  test("opt-out via environment variables", () => {
    expect(isOptedOut(undefined, { TOKEN_SCOPE_CACHE_TIMER: "0" })).toBe(true);
    expect(isOptedOut(undefined, { TOKEN_SCOPE_CACHE_TIMER: "false" })).toBe(true);
    expect(isOptedOut(undefined, { TOKEN_SCOPE_DISABLE_CACHE_TIMER: "1" })).toBe(true);
    expect(isOptedOut(undefined, {})).toBe(false);
  });
});

describe("register hook wiring and coexistence", () => {
  test("opted out register does not attach hooks", () => {
    const events: string[] = [];
    const fakeOn = ((event: string) => {
      events.push(event);
    }) as any;

    register(fakeOn, { cacheTimer: false });
    expect(events.length).toBe(0);
  });

  test("disabled caching does not attach hooks", () => {
    const events: string[] = [];
    const fakeOn = ((event: string) => {
      events.push(event);
    }) as any;

    if (typeof process !== "undefined" && process?.env) {
      const orig = process.env.DISABLE_PROMPT_CACHING;
      try {
        process.env.DISABLE_PROMPT_CACHING = "1";
        register(fakeOn, {});
        expect(events.length).toBe(0);
      } finally {
        if (orig === undefined) delete process.env.DISABLE_PROMPT_CACHING;
        else process.env.DISABLE_PROMPT_CACHING = orig;
      }
    } else {
      expect(events.length).toBe(0);
    }
  });

  test("attaches session.start and turn.step when enabled", () => {
    const events: string[] = [];
    const fakeOn = ((event: string) => {
      events.push(event);
    }) as any;

    register(fakeOn, { cacheTimer: true });
    expect(events).toContain("session.start");
    expect(events).toContain("turn.step");
  });

  test("turn.step ignores subagents and updates state for main session", async () => {
    let turnHandler: any;
    const fakeOn = ((event: string, handler: any) => {
      if (event === "turn.step") turnHandler = handler;
    }) as any;

    register(fakeOn, { cacheTimer: true });
    expect(turnHandler).toBeDefined();

    let currentTime = 1_000_000;
    const fake$ = {
      clock: {
        now: async () => currentTime,
      },
    };

    // Subagent step: ignored
    const subagentGen = turnHandler(
      fake$,
      { agentId: "subagent-1" },
      async function* () {
        return { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 50 } };
      }
    );
    const subagentResult = (await subagentGen.next()).value;
    expect(subagentResult.usage.input_tokens).toBe(100);

    // Main session step 1
    const mainGen1 = turnHandler(
      fake$,
      {},
      async function* () {
        return { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } };
      }
    );
    const mainResult1 = (await mainGen1.next()).value;
    expect(mainResult1.usage.input_tokens).toBe(100);

    // Main session step 2 after 10m gap with cache miss (overage fallback)
    currentTime += 600_000;
    const mainGen2 = turnHandler(
      fake$,
      {},
      async function* () {
        return { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000 } };
      }
    );
    const mainResult2 = (await mainGen2.next()).value;
    expect(mainResult2.usage.cache_creation_input_tokens).toBe(3000);
  });
});

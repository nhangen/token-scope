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
    expect(parseTtl("invalid")).toBe(undefined);
    expect(parseTtl(null)).toBe(undefined);
  });

  test("parseTtl reads a bare number as seconds on both sides of 1000", () => {
    expect(parseTtl("999")).toBe(999_000);
    expect(parseTtl("1000")).toBe(1_000_000);
    expect(parseTtl("3600")).toBe(3_600_000);
    expect(parseTtl(300)).toBe(300_000);
    expect(parseTtl(3600)).toBe(3_600_000);
  });

  test("parseTtl rejects zero", () => {
    expect(parseTtl("0")).toBe(undefined);
    expect(parseTtl("0s")).toBe(undefined);
    expect(parseTtl(0)).toBe(undefined);
  });

  test("DISABLE_PROMPT_CACHING returns null (show nothing)", () => {
    expect(resolveTtl({ DISABLE_PROMPT_CACHING: "1" })).toBe(null);
    expect(resolveTtl({ DISABLE_PROMPT_CACHING: "true" })).toBe(null);
  });

  test("FORCE_PROMPT_CACHING_5M returns 5 minutes", () => {
    expect(resolveTtl({ FORCE_PROMPT_CACHING_5M: "1" })).toBe(300_000);
  });

  test("CLAUDE_CODE_PROMPT_CACHE_TTL env var takes precedence over settings", () => {
    expect(resolveTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, { promptCacheTtl: "1h" })).toBe(300_000);
    expect(resolveTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, { promptCacheTtl: "5m" })).toBe(3_600_000);
  });

  test("FORCE_PROMPT_CACHING_5M takes precedence over a configured TTL", () => {
    expect(resolveTtl({ FORCE_PROMPT_CACHING_5M: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" })).toBe(300_000);
  });

  test("promptCacheTtl from settings", () => {
    expect(resolveTtl({}, { promptCacheTtl: "5m" })).toBe(300_000);
    expect(resolveTtl({}, { promptCacheTtl: "1h" })).toBe(3_600_000);
  });

  test("an unparseable env TTL falls through to a valid settings TTL", () => {
    expect(resolveTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "30min" }, { promptCacheTtl: "5m" })).toBe(300_000);
    expect(resolveTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "" }, { promptCacheTtl: "5m" })).toBe(300_000);
  });

  test("defaults to 1 hour", () => {
    expect(resolveTtl({}, {})).toBe(3_600_000);
    expect(resolveTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "garbage" }, { promptCacheTtl: "nope" })).toBe(3_600_000);
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
  function makeMock$(envVars: Record<string, string | undefined> = {}, settings: Record<string, unknown> = {}) {
    let timerCancelled = false;
    let timerStarted = false;
    let timerCallback: (() => void) | undefined;
    let currentStatus: string | undefined = "stale";
    let currentTime = 1_000_000;

    const $ = {
      env: {
        get: async (name: string) => envVars[name],
      },
      settings: {
        read: async () => settings,
      },
      clock: {
        now: async () => currentTime,
        every: (_ms: number, fn: () => void) => {
          timerStarted = true;
          timerCallback = fn;
          return () => {
            timerCancelled = true;
          };
        },
      },
      ui: {
        status: (text: string | undefined) => {
          currentStatus = text;
        },
      },
    };

    return {
      $,
      getStatus: () => currentStatus,
      isTimerCancelled: () => timerCancelled,
      isTimerStarted: () => timerStarted,
      tick: async () => {
        timerCallback?.();
        await Promise.resolve();
      },
      setTime: (t: number) => {
        currentTime = t;
      },
    };
  }

  const HEALTHY = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };

  test("/clear (session.end reason clear) resets the countdown and the 5m fallback", async () => {
    const handlers: Record<string, any> = {};
    register(((event: string, handler: any) => {
      handlers[event] = handler;
    }) as any, { cacheTimer: true });
    const m = makeMock$();
    const turn = async (usage: Record<string, number>) =>
      (await handlers["turn.step"](m.$, {}, async function* () {
        return { usage };
      }).next()).value;

    await handlers["session.start"](m.$, {}, (e: any) => e);
    await turn(HEALTHY);
    m.setTime(1_600_000);
    await turn({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000 });
    await m.tick();
    expect(m.getStatus()).toBe("cache warm 5:00 (5m) · hit 0%");

    let nextCalled = false;
    await handlers["session.end"](m.$, { reason: "clear" }, (e: any) => {
      nextCalled = true;
      return e;
    });
    expect(nextCalled).toBe(true);
    expect(m.getStatus()).toBe(undefined);
    await m.tick();
    expect(m.getStatus()).toBe(undefined);

    m.setTime(1_700_000);
    await turn(HEALTHY);
    await m.tick();
    expect(m.getStatus()).toBe("cache warm 60:00 · hit 90%");
  });

  test("attaches session.start, session.end, and turn.step", () => {
    const events: string[] = [];
    const fakeOn = ((event: string) => {
      events.push(event);
    }) as any;

    register(fakeOn, { cacheTimer: true });
    expect(events).toContain("session.start");
    expect(events).toContain("session.end");
    expect(events).toContain("turn.step");
  });

  function wire(options: Record<string, unknown>) {
    let startHandler: any;
    let turnHandler: any;
    const fakeOn = ((event: string, handler: any) => {
      if (event === "session.start") startHandler = handler;
      if (event === "turn.step") turnHandler = handler;
    }) as any;
    register(fakeOn, options);
    return {
      start: ($: any) => startHandler($, {}, (e: any) => e),
      turn: async ($: any, e: Record<string, unknown>, usage: Record<string, number> | undefined) =>
        (await turnHandler($, e, async function* () {
          return usage === undefined ? {} : { usage };
        }).next()).value,
    };
  }

  async function expectDisabled(options: Record<string, unknown>, envVars: Record<string, string | undefined>) {
    const m = makeMock$(envVars);
    const w = wire(options);
    await w.start(m.$);
    expect(m.getStatus()).toBe(undefined);
    expect(m.isTimerStarted()).toBe(false);
    await w.turn(m.$, {}, HEALTHY);
    await m.tick();
    expect(m.getStatus()).toBe(undefined);
  }

  test("session.start honors userConfig opt-out and clears the status", async () => {
    let nextCalled = false;
    let startHandler: any;
    register(((event: string, handler: any) => {
      if (event === "session.start") startHandler = handler;
    }) as any, { cacheTimer: false });
    await startHandler(makeMock$().$, {}, (e: any) => {
      nextCalled = true;
      return e;
    });
    expect(nextCalled).toBe(true);
    await expectDisabled({ cacheTimer: false }, {});
  });

  test("session.start honors env opt-out read via $.env.get", async () => {
    await expectDisabled({ cacheTimer: true }, { TOKEN_SCOPE_CACHE_TIMER: "0" });
    await expectDisabled({ cacheTimer: true }, { TOKEN_SCOPE_DISABLE_CACHE_TIMER: "1" });
  });

  test("session.start honors DISABLE_PROMPT_CACHING via $.env.get", async () => {
    await expectDisabled({ cacheTimer: true }, { DISABLE_PROMPT_CACHING: "1" });
  });

  test("an enabled session shows the countdown, so the disabled assertions are not vacuous", async () => {
    const m = makeMock$();
    const w = wire({ cacheTimer: true });
    await w.start(m.$);
    expect(m.isTimerStarted()).toBe(true);
    await w.turn(m.$, {}, HEALTHY);
    await m.tick();
    expect(m.getStatus()).toBe("cache warm 60:00 · hit 90%");
  });

  test("session.start honors promptCacheTtl from $.settings.read", async () => {
    let startHandler: any;
    let turnHandler: any;
    const fakeOn = ((event: string, handler: any) => {
      if (event === "session.start") startHandler = handler;
      if (event === "turn.step") turnHandler = handler;
    }) as any;

    register(fakeOn, { cacheTimer: true });
    const { $, getStatus, tick, setTime } = makeMock$({}, { promptCacheTtl: "5m" });

    await startHandler($, {}, (e: any) => e);

    await tick();
    expect(getStatus()).toBe(undefined);

    // Run a turn at t=1,000,000
    const gen = turnHandler(
      $,
      {},
      async function* () {
        return { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } };
      }
    );
    await gen.next();

    // 100 seconds into the 5m TTL => 200s left => 3:20
    setTime(1_100_000);
    await tick();
    expect(getStatus()).toBe("cache warm 3:20 · hit 90%");

    // Past 5m (301 seconds later) => cold
    setTime(1_301_000);
    await tick();
    expect(getStatus()).toBe("cache cold");
  });

  test("session.start cancels previous timer interval on restart", async () => {
    let startHandler: any;
    const fakeOn = ((event: string, handler: any) => {
      if (event === "session.start") startHandler = handler;
    }) as any;

    register(fakeOn, { cacheTimer: true });
    const { $, isTimerCancelled } = makeMock$();

    await startHandler($, {}, (e: any) => e);
    expect(isTimerCancelled()).toBe(false);

    await startHandler($, {}, (e: any) => e);
    expect(isTimerCancelled()).toBe(true);
  });

  test("turn.step ignores subagents and updates state for main session", async () => {
    let turnHandler: any;
    let startHandler: any;
    const fakeOn = ((event: string, handler: any) => {
      if (event === "session.start") startHandler = handler;
      if (event === "turn.step") turnHandler = handler;
    }) as any;

    register(fakeOn, { cacheTimer: true });
    const { $, getStatus, tick, setTime } = makeMock$();

    await startHandler($, {}, (e: any) => e);

    // Subagent step: ignored
    const subagentGen = turnHandler(
      $,
      { agentId: "subagent-1" },
      async function* () {
        return { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 50 } };
      }
    );
    const subagentResult = (await subagentGen.next()).value;
    expect(subagentResult.usage.input_tokens).toBe(100);
    await tick();
    expect(getStatus()).toBe(undefined);

    // Main session step 1 at t=1,000,000
    const mainGen1 = turnHandler(
      $,
      {},
      async function* () {
        return { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } };
      }
    );
    const mainResult1 = (await mainGen1.next()).value;
    expect(mainResult1.usage.input_tokens).toBe(100);

    // Main session step 2 after 10m gap with cache miss (overage fallback)
    setTime(1_600_000);
    const mainGen2 = turnHandler(
      $,
      {},
      async function* () {
        return { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000 } };
      }
    );
    const mainResult2 = (await mainGen2.next()).value;
    expect(mainResult2.usage.cache_creation_input_tokens).toBe(3000);

    // Status line now displays 5m fallback countdown with (5m) tag
    // At t=1,710,000 (110s into the 300s TTL) => 190s left => 3:10 (5m)
    setTime(1_710_000);
    await tick();
    expect(getStatus()).toBe("cache warm 3:10 (5m) · hit 0%");
  });
});

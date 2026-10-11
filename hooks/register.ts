import type { Register } from "claude-code";

function getFallbackEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process?.env ? process.env : {};
}

export function isEnvTrue(val: string | undefined): boolean {
  if (!val) return false;
  const s = val.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
}

export function parseTtl(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    return Math.round(val);
  }
  if (typeof val !== "string") return undefined;
  const s = val.trim().toLowerCase();
  if (s === "5m") return 5 * 60 * 1000;
  if (s === "1h") return 60 * 60 * 1000;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s);
  if (match) {
    const n = parseFloat(match[1]!);
    const unit = match[2];
    if (unit === "h") return Math.round(n * 60 * 60 * 1000);
    if (unit === "m") return Math.round(n * 60 * 1000);
    if (unit === "s") return Math.round(n * 1000);
    if (unit === "ms") return Math.round(n);
    return n >= 1000 ? Math.round(n) : Math.round(n * 1000);
  }
  return undefined;
}

export function resolveTtl(
  env: Record<string, string | undefined> = getFallbackEnv(),
  options?: Record<string, unknown>,
  settings?: Record<string, unknown>
): number | null {
  if (isEnvTrue(env["DISABLE_PROMPT_CACHING"])) {
    return null;
  }
  if (isEnvTrue(env["FORCE_PROMPT_CACHING_5M"])) {
    return 5 * 60 * 1000;
  }
  const configured =
    env["CLAUDE_CODE_PROMPT_CACHE_TTL"] ??
    (settings?.["promptCacheTtl"] as string | undefined) ??
    (options?.["promptCacheTtl"] as string | undefined) ??
    env["promptCacheTtl"];
  if (configured !== undefined) {
    const parsed = parseTtl(configured);
    if (parsed !== undefined) return parsed;
  }
  if (isEnvTrue(env["ENABLE_PROMPT_CACHING_1H"])) {
    return 60 * 60 * 1000;
  }
  return 60 * 60 * 1000;
}

export function isOptedOut(
  options?: Record<string, unknown>,
  env: Record<string, string | undefined> = getFallbackEnv()
): boolean {
  if (options?.["cacheTimer"] === false) return true;
  if (env["TOKEN_SCOPE_CACHE_TIMER"] === "0" || env["TOKEN_SCOPE_CACHE_TIMER"]?.toLowerCase() === "false") return true;
  if (isEnvTrue(env["TOKEN_SCOPE_DISABLE_CACHE_TIMER"])) return true;
  return false;
}

export function isOverageFallback(
  gap: number,
  effectiveTtl: number,
  read: number,
  write: number
): boolean {
  const fiveMinMs = 5 * 60 * 1000;
  if (gap <= fiveMinMs || gap >= effectiveTtl) return false;
  return read <= 100 && write >= 1000;
}

export function label(
  now: number,
  lastAt: number | undefined,
  hit: number | undefined,
  ttlMs: number | null | undefined = 60 * 60 * 1000,
  fallback5m: boolean = false
): string | undefined {
  if (lastAt === undefined) return undefined;
  if (ttlMs === null || ttlMs === undefined || ttlMs <= 0) return undefined;
  const left = ttlMs - (now - lastAt);
  if (left <= 0) return "cache cold";
  const s = Math.ceil(left / 1000);
  const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const tag = fallback5m ? " (5m)" : "";
  return hit === undefined ? `cache warm ${mmss}${tag}` : `cache warm ${mmss}${tag} · hit ${hit}%`;
}

export const register: Register = (on, options) => {
  const opts = options as Record<string, unknown> | undefined;

  let cancelTimer: (() => void) | undefined;
  let effectiveTtl = 60 * 60 * 1000;
  let is5mFallback = false;
  let lastAt: number | undefined;
  let hit: number | undefined;
  let isEnabled = true;

  on("session.start", async ($, e, next) => {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = undefined;
    }
    lastAt = undefined;
    hit = undefined;
    is5mFallback = false;

    // Check userConfig opt-out first
    if (opts?.["cacheTimer"] === false) {
      isEnabled = false;
      $.ui.status(undefined);
      return next(e);
    }

    // Read environment variables via $.env.get (using string literals for static scanner)
    const env: Record<string, string | undefined> = {};
    try {
      const [disableCaching, force5m, ttlEnv, enable1h, disableTimer, timerEnv] = await Promise.all([
        $.env.get("DISABLE_PROMPT_CACHING"),
        $.env.get("FORCE_PROMPT_CACHING_5M"),
        $.env.get("CLAUDE_CODE_PROMPT_CACHE_TTL"),
        $.env.get("ENABLE_PROMPT_CACHING_1H"),
        $.env.get("TOKEN_SCOPE_DISABLE_CACHE_TIMER"),
        $.env.get("TOKEN_SCOPE_CACHE_TIMER"),
      ]);
      env["DISABLE_PROMPT_CACHING"] = disableCaching;
      env["FORCE_PROMPT_CACHING_5M"] = force5m;
      env["CLAUDE_CODE_PROMPT_CACHE_TTL"] = ttlEnv;
      env["ENABLE_PROMPT_CACHING_1H"] = enable1h;
      env["TOKEN_SCOPE_DISABLE_CACHE_TIMER"] = disableTimer;
      env["TOKEN_SCOPE_CACHE_TIMER"] = timerEnv;
    } catch {
      if (typeof process !== "undefined" && process?.env) {
        Object.assign(env, process.env);
      }
    }

    // Check env-level opt-out
    if (isOptedOut(opts, env)) {
      isEnabled = false;
      $.ui.status(undefined);
      return next(e);
    }

    // Read user settings via $.settings.read()
    let settings: Record<string, unknown> | undefined;
    try {
      settings = (await $.settings.read()) as Record<string, unknown>;
    } catch {
      // Ignore if settings read is unsupported in test mock
    }

    const configuredTtl = resolveTtl(env, opts, settings);
    if (configuredTtl === null) {
      // DISABLE_PROMPT_CACHING active: show nothing
      isEnabled = false;
      $.ui.status(undefined);
      return next(e);
    }

    isEnabled = true;
    effectiveTtl = configuredTtl;

    cancelTimer = $.clock.every(1000, () => {
      void $.clock.now().then(now => $.ui.status(label(now, lastAt, hit, effectiveTtl, is5mFallback)));
    });

    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const r = yield* next(e);
    if (!isEnabled || e.agentId !== undefined || !r?.usage) return r;
    const u = r.usage;
    const now = await $.clock.now();

    if (lastAt !== undefined && !is5mFallback && effectiveTtl > 5 * 60 * 1000) {
      const gap = now - lastAt;
      const read = u.cache_read_input_tokens ?? 0;
      const write = u.cache_creation_input_tokens ?? 0;
      if (isOverageFallback(gap, effectiveTtl, read, write)) {
        effectiveTtl = 5 * 60 * 1000;
        is5mFallback = true;
      }
    }

    lastAt = now;
    const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    hit = total > 0 ? Math.round((100 * (u.cache_read_input_tokens ?? 0)) / total) : undefined;
    return r;
  });
};

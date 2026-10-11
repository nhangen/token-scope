import { getPricing, type ModelPricing } from "@/pricing";
import { CREDIT_WEIGHTS } from "@/credits";

export interface CacheTurnRecord {
  uuid: string;
  sessionId: string;
  /** Subagent transcripts share the parent sessionId; agentId separates their cache streams. */
  agentId?: string;
  cwd?: string;
  timestampMs: number;
  model: string;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Portion of cacheWriteTokens billed at the 1h tier (usage.cache_creation.ephemeral_1h_input_tokens). */
  cacheWrite1hTokens?: number;
  costUsd: number | null;
  isSubagent?: boolean;
}

export interface CacheTurnSet {
  mainTurns: CacheTurnRecord[];
  subagentTurns: CacheTurnRecord[];
  /** False when the source has no subagent transcripts (SQLite), so subagent counts are unmeasured, not zero. */
  subagentsSupported: boolean;
}

export interface TokenMix {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  totalInputTokens: number;
  cacheReadPct: number | null;
  cacheWritePct: number | null;
  uncachedInputPct: number | null;
}

export interface CostMix {
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  uncachedInputCostUsd: number;
  totalInputCostUsd: number;
  cacheReadCostPct: number | null;
  cacheWriteCostPct: number | null;
  uncachedInputCostPct: number | null;
  cacheReadCredits: number;
  cacheWriteCredits: number;
  uncachedInputCredits: number;
  totalInputCredits: number;
  cacheReadCreditsPct: number | null;
  cacheWriteCreditsPct: number | null;
  uncachedInputCreditsPct: number | null;
}

export type MissType = "expiry" | "growth" | "invalidation" | "cold" | "hit";

export interface MissClassification {
  type: MissType;
  turn: number;
  sessionId: string;
  timestampMs: number;
  gapMs: number | null;
  contextTokens: number;
  prevContextTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  rebuildPrefixTokens: number;
  extraCostUsd: number;
  extraCredits: number;
  model: string;
  isSubagent: boolean;
}

export interface GapHistogramBucket {
  label: string;
  minSec: number;
  maxSec: number | null;
  count: number;
  pct: number;
}

export interface PolicySimulationResult {
  policyId: string;
  title: string;
  weeklySavingsUsd: number;
  totalSavingsUsd: number;
  /** Model-independent token-delta estimate, including turns with unknown USD pricing. */
  weeklySavingsCredits: number;
  assumptions: string[];
  simulatedTotalCostUsd: number;
}

export interface CacheEconomicsAnalysis {
  correctedHitPct: number | null;
  legacyHitPct: number | null;
  tokenMix: TokenMix;
  costMix: CostMix;
  misses: {
    totalWrites: number;
    expiries: number;
    growths: number;
    invalidations: number;
    colds: number;
    totalExpiryExtraCostUsd: number;
    totalExpiryExtraCredits: number;
    totalInvalidationExtraCostUsd: number;
    totalInvalidationExtraCredits: number;
    items: MissClassification[];
  };
  subagentMisses: {
    totalTurns: number;
    coldStarts: number;
    expiries: number;
    growths: number;
    invalidations: number;
    totalExpiryExtraCostUsd: number;
    totalExpiryExtraCredits: number;
    totalInvalidationExtraCostUsd: number;
    totalInvalidationExtraCredits: number;
    items: MissClassification[];
  };
  gapHistogram: {
    totalGaps: number;
    buckets: GapHistogramBucket[];
  };
  simulations: PolicySimulationResult[];
  windowWeeks: number;
  /** Turns whose model has no pricing entry; their tokens count toward the mix but add $0 to every dollar figure. */
  unpriced: { turns: number; tokens: number; models: string[] };
  /** Turns that are both priced and carry a reader costUsd: reader total vs tier-aware token pricing. */
  reconciliation: {
    turns: number;
    readerCostUsd: number;
    tokenPricedCostUsd: number;
    deltaUsd: number;
  };
}

export interface CacheEconomicsInput {
  mainTurns: CacheTurnRecord[];
  subagentTurns?: CacheTurnRecord[];
  sinceSec: number;
  nowMs?: number;
}

export const MAIN_TTL_MS = 60 * 60 * 1000;
export const SUBAGENT_TTL_MS = 5 * 60 * 1000;

// pricing.ts carries only the 5m write rate (1.25x input); the 1h tier bills 2.0x input.
const ONE_HOUR_WRITE_INPUT_MULTIPLE = 2.0;

type WriteSplit = { cacheWriteTokens: number; cacheWrite1hTokens?: number };

function splitWrites(t: WriteSplit): { w5m: number; w1h: number } {
  const w1h = Math.min(Math.max(0, t.cacheWrite1hTokens ?? 0), t.cacheWriteTokens);
  return { w5m: t.cacheWriteTokens - w1h, w1h };
}

export function cacheWriteCostUsd(t: WriteSplit, p: ModelPricing): number {
  const { w5m, w1h } = splitWrites(t);
  return (w5m * p.cacheWritePerMillion + w1h * p.inputPerMillion * ONE_HOUR_WRITE_INPUT_MULTIPLE) / 1_000_000;
}

export function cacheWriteCredits(t: WriteSplit): number {
  const { w5m, w1h } = splitWrites(t);
  return w5m * CREDIT_WEIGHTS.cacheWrite + w1h * CREDIT_WEIGHTS.input * ONE_HOUR_WRITE_INPUT_MULTIPLE;
}

export function classifyTurn(
  prev: CacheTurnRecord | null,
  curr: CacheTurnRecord,
  isSubagent = false,
  turnNumber = 1
): MissClassification {
  const isCold = prev === null;
  const ttlMs = isSubagent ? SUBAGENT_TTL_MS : MAIN_TTL_MS;
  const gapMs = prev !== null ? Math.max(0, curr.timestampMs - prev.timestampMs) : null;
  const prevContext = prev !== null ? prev.inputTokens + prev.cacheReadTokens + prev.cacheWriteTokens : 0;
  const currContext = curr.inputTokens + curr.cacheReadTokens + curr.cacheWriteTokens;
  const deltaContext = Math.max(0, currContext - prevContext);

  let type: MissType = "growth";
  let rebuildPrefixTokens = 0;
  let extraCostUsd = 0;
  let extraCredits = 0;

  const p = getPricing(curr.model);
  const writePerToken = p && curr.cacheWriteTokens > 0 ? cacheWriteCostUsd(curr, p) / curr.cacheWriteTokens : 0;
  const readPerToken = p ? p.cacheReadPerMillion / 1_000_000 : 0;
  const writeCreditsPerToken = curr.cacheWriteTokens > 0 ? cacheWriteCredits(curr) / curr.cacheWriteTokens : 0;

  if (isCold) {
    type = "cold";
  } else if (curr.cacheWriteTokens === 0) {
    type = "hit";
  } else {
    if (gapMs !== null && gapMs > ttlMs) {
      type = "expiry";
      rebuildPrefixTokens = Math.min(prevContext, curr.cacheWriteTokens);
      extraCostUsd = rebuildPrefixTokens * (writePerToken - readPerToken);
      extraCredits = rebuildPrefixTokens * (writeCreditsPerToken - CREDIT_WEIGHTS.cacheRead);
    } else {
      const isGrowth =
        curr.cacheReadTokens >= prevContext * 0.75 ||
        curr.cacheWriteTokens <= Math.max(deltaContext * 1.25, 2048);

      if (isGrowth) {
        type = "growth";
      } else {
        type = "invalidation";
        rebuildPrefixTokens = Math.min(prevContext, curr.cacheWriteTokens);
        extraCostUsd = rebuildPrefixTokens * (writePerToken - readPerToken);
        extraCredits = rebuildPrefixTokens * (writeCreditsPerToken - CREDIT_WEIGHTS.cacheRead);
      }
    }
  }

  return {
    type,
    turn: turnNumber,
    sessionId: curr.sessionId,
    timestampMs: curr.timestampMs,
    gapMs,
    contextTokens: currContext,
    prevContextTokens: prevContext,
    cacheWriteTokens: curr.cacheWriteTokens,
    cacheWrite1hTokens: splitWrites(curr).w1h,
    cacheReadTokens: curr.cacheReadTokens,
    inputTokens: curr.inputTokens,
    rebuildPrefixTokens,
    extraCostUsd,
    extraCredits,
    model: curr.model,
    isSubagent,
  };
}

export function computeGapHistogram(gapsSec: number[]): { totalGaps: number; buckets: GapHistogramBucket[] } {
  const bucketDefs = [
    { label: "< 1m", minSec: 0, maxSec: 60 },
    { label: "1m – 5m", minSec: 60, maxSec: 300 },
    { label: "5m – 15m", minSec: 300, maxSec: 900 },
    { label: "15m – 30m", minSec: 900, maxSec: 1800 },
    { label: "30m – 60m", minSec: 1800, maxSec: 3600 },
    { label: "1h – 2h", minSec: 3600, maxSec: 7200 },
    { label: "2h – 4h", minSec: 7200, maxSec: 14400 },
    { label: "> 4h", minSec: 14400, maxSec: null },
  ];

  const counts = new Array(bucketDefs.length).fill(0);
  for (const g of gapsSec) {
    for (let i = 0; i < bucketDefs.length; i++) {
      const def = bucketDefs[i]!;
      if (def.maxSec === null) {
        if (g >= def.minSec) counts[i]++;
      } else if (g >= def.minSec && g < def.maxSec) {
        counts[i]++;
        break;
      }
    }
  }

  const totalGaps = gapsSec.length;
  const buckets: GapHistogramBucket[] = bucketDefs.map((def, i) => ({
    label: def.label,
    minSec: def.minSec,
    maxSec: def.maxSec,
    count: counts[i],
    pct: totalGaps > 0 ? (counts[i] / totalGaps) * 100 : 0,
  }));

  return { totalGaps, buckets };
}

export function analyzeCacheEconomics(input: CacheEconomicsInput): CacheEconomicsAnalysis {
  const mainTurns = input.mainTurns.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const subagentTurns = (input.subagentTurns ?? []).slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const allTurns = [...mainTurns, ...subagentTurns];

  let totalRead = 0;
  let totalWrite = 0;
  let totalInput = 0;
  let totalReadUsd = 0;
  let totalWriteUsd = 0;
  let totalInputUsd = 0;
  let totalWriteCredits = 0;
  let unpricedTurns = 0;
  let unpricedTokens = 0;
  const unpricedModels = new Set<string>();

  for (const t of allTurns) {
    totalRead += t.cacheReadTokens;
    totalWrite += t.cacheWriteTokens;
    totalInput += t.inputTokens;
    totalWriteCredits += cacheWriteCredits(t);

    const p = getPricing(t.model);
    if (p) {
      totalReadUsd += (t.cacheReadTokens * p.cacheReadPerMillion) / 1_000_000;
      totalWriteUsd += cacheWriteCostUsd(t, p);
      totalInputUsd += (t.inputTokens * p.inputPerMillion) / 1_000_000;
    } else {
      unpricedTurns++;
      unpricedTokens += t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
      unpricedModels.add(t.model);
    }
  }

  const totalInputTokens = totalRead + totalWrite + totalInput;
  const tokenMix: TokenMix = {
    cacheReadTokens: totalRead,
    cacheWriteTokens: totalWrite,
    uncachedInputTokens: totalInput,
    totalInputTokens,
    cacheReadPct: totalInputTokens > 0 ? (totalRead / totalInputTokens) * 100 : null,
    cacheWritePct: totalInputTokens > 0 ? (totalWrite / totalInputTokens) * 100 : null,
    uncachedInputPct: totalInputTokens > 0 ? (totalInput / totalInputTokens) * 100 : null,
  };

  const totalInputCostUsd = totalReadUsd + totalWriteUsd + totalInputUsd;
  const totalReadCredits = totalRead * CREDIT_WEIGHTS.cacheRead;
  const totalInputCreditsOnly = totalInput * CREDIT_WEIGHTS.input;
  const totalInputCredits = totalReadCredits + totalWriteCredits + totalInputCreditsOnly;

  const costMix: CostMix = {
    cacheReadCostUsd: totalReadUsd,
    cacheWriteCostUsd: totalWriteUsd,
    uncachedInputCostUsd: totalInputUsd,
    totalInputCostUsd,
    cacheReadCostPct: totalInputCostUsd > 0 ? (totalReadUsd / totalInputCostUsd) * 100 : null,
    cacheWriteCostPct: totalInputCostUsd > 0 ? (totalWriteUsd / totalInputCostUsd) * 100 : null,
    uncachedInputCostPct: totalInputCostUsd > 0 ? (totalInputUsd / totalInputCostUsd) * 100 : null,
    cacheReadCredits: totalReadCredits,
    cacheWriteCredits: totalWriteCredits,
    uncachedInputCredits: totalInputCreditsOnly,
    totalInputCredits,
    cacheReadCreditsPct: totalInputCredits > 0 ? (totalReadCredits / totalInputCredits) * 100 : null,
    cacheWriteCreditsPct: totalInputCredits > 0 ? (totalWriteCredits / totalInputCredits) * 100 : null,
    uncachedInputCreditsPct: totalInputCredits > 0 ? (totalInputCreditsOnly / totalInputCredits) * 100 : null,
  };

  const correctedHitPct = totalInputTokens > 0 ? (totalRead / totalInputTokens) * 100 : null;
  const nonWriteTokens = totalRead + totalInput;
  const legacyHitPct = nonWriteTokens > 0 ? (totalRead / nonWriteTokens) * 100 : null;

  const mainBySession = new Map<string, CacheTurnRecord[]>();
  for (const t of mainTurns) {
    const list = mainBySession.get(t.sessionId) ?? [];
    list.push(t);
    mainBySession.set(t.sessionId, list);
  }

  const mainMissItems: MissClassification[] = [];
  const gapsSec: number[] = [];

  for (const [, sTurns] of mainBySession) {
    sTurns.sort((a, b) => a.timestampMs - b.timestampMs);
    let prev: CacheTurnRecord | null = null;
    for (let i = 0; i < sTurns.length; i++) {
      const curr = sTurns[i]!;
      if (prev !== null) {
        const gap = Math.max(0, curr.timestampMs - prev.timestampMs);
        gapsSec.push(gap / 1000);
      }
      const item = classifyTurn(prev, curr, false, i + 1);
      mainMissItems.push(item);
      prev = curr;
    }
  }

  const subagentByStream = new Map<string, CacheTurnRecord[]>();
  for (const t of subagentTurns) {
    const key = `${t.sessionId}\u0000${t.agentId ?? ""}`;
    const list = subagentByStream.get(key) ?? [];
    list.push(t);
    subagentByStream.set(key, list);
  }

  const subagentMissItems: MissClassification[] = [];
  for (const [, sTurns] of subagentByStream) {
    sTurns.sort((a, b) => a.timestampMs - b.timestampMs);
    let prev: CacheTurnRecord | null = null;
    for (let i = 0; i < sTurns.length; i++) {
      const curr = sTurns[i]!;
      const item = classifyTurn(prev, curr, true, i + 1);
      subagentMissItems.push(item);
      prev = curr;
    }
  }

  const writesOnly = mainMissItems.filter((m) => m.cacheWriteTokens > 0);
  const expiries = writesOnly.filter((m) => m.type === "expiry");
  const growths = writesOnly.filter((m) => m.type === "growth");
  const invalidations = writesOnly.filter((m) => m.type === "invalidation");
  const colds = writesOnly.filter((m) => m.type === "cold");
  const totalExpiryExtraCostUsd = expiries.reduce((s, m) => s + m.extraCostUsd, 0);
  const totalExpiryExtraCredits = expiries.reduce((s, m) => s + m.extraCredits, 0);
  const totalInvalidationExtraCostUsd = invalidations.reduce((s, m) => s + m.extraCostUsd, 0);
  const totalInvalidationExtraCredits = invalidations.reduce((s, m) => s + m.extraCredits, 0);

  const subWritesOnly = subagentMissItems.filter((m) => m.cacheWriteTokens > 0);
  const subColdStarts = subWritesOnly.filter((m) => m.type === "cold");
  const subExpiries = subWritesOnly.filter((m) => m.type === "expiry");
  const subGrowths = subWritesOnly.filter((m) => m.type === "growth");
  const subInvalidations = subWritesOnly.filter((m) => m.type === "invalidation");
  const subExpiryCostUsd = subExpiries.reduce((s, m) => s + m.extraCostUsd, 0);
  const subExpiryCredits = subExpiries.reduce((s, m) => s + m.extraCredits, 0);
  const subInvalidationCostUsd = subInvalidations.reduce((s, m) => s + m.extraCostUsd, 0);
  const subInvalidationCredits = subInvalidations.reduce((s, m) => s + m.extraCredits, 0);

  const gapHistogram = computeGapHistogram(gapsSec);

  let earliestTs = Infinity;
  let latestTs = -Infinity;
  for (const t of allTurns) {
    if (t.timestampMs < earliestTs) earliestTs = t.timestampMs;
    if (t.timestampMs > latestTs) latestTs = t.timestampMs;
  }
  const windowStart = input.sinceSec > 0 ? input.sinceSec * 1000 : allTurns.length > 0 ? earliestTs : 0;
  const windowEnd = input.nowMs ?? (allTurns.length > 0 ? latestTs : windowStart);
  const windowWeeks = Math.max(0.14, (windowEnd - windowStart) / (7 * 86_400_000));

  // Sims price their deltas from tokens, so the baseline must too; the reader's
  // costUsd prices every write at the 5m rate and is only used for unpriced models.
  let actualTotalCostUsd = 0;
  let reconciledTurns = 0;
  let readerCostUsd = 0;
  let tokenPricedCostUsd = 0;
  for (const t of allTurns) {
    const p = getPricing(t.model);
    if (p) {
      const tokenCost =
        (t.outputTokens * p.outputPerMillion +
          t.inputTokens * p.inputPerMillion +
          t.cacheReadTokens * p.cacheReadPerMillion) /
          1_000_000 +
        cacheWriteCostUsd(t, p);
      actualTotalCostUsd += tokenCost;
      if (t.costUsd !== null) {
        reconciledTurns++;
        readerCostUsd += t.costUsd;
        tokenPricedCostUsd += tokenCost;
      }
    } else if (t.costUsd !== null) {
      actualTotalCostUsd += t.costUsd;
    }
  }

  const simulations: PolicySimulationResult[] = [];

  simulations.push({
    policyId: "actual_baseline",
    title: "Baseline (Current policy: 1h main TTL, 5m subagent TTL)",
    weeklySavingsUsd: 0,
    totalSavingsUsd: 0,
    weeklySavingsCredits: 0,
    assumptions: [
      "Current observed configuration: 1h TTL on main loop, 5m TTL on subagents",
      "Token-priced with 5m/1h write tiers; see reconciliation for the gap against reader-reported cost",
      `Weekly figures extrapolated over a ${(windowWeeks * 7).toFixed(1)}-day window`,
    ],
    simulatedTotalCostUsd: actualTotalCostUsd,
  });

  let main5mWriteSavingsUsd = 0;
  let main5mExpiryPenaltiesUsd = 0;
  let main5mSavingsCredits = 0;
  let main5mBreakEvenGapsCount = 0;

  for (const m of mainMissItems) {
    const p = getPricing(m.model);
    if (m.cacheWrite1hTokens > 0) {
      const writes5m = { cacheWriteTokens: m.cacheWriteTokens, cacheWrite1hTokens: 0 };
      main5mSavingsCredits += cacheWriteCredits(m) - cacheWriteCredits(writes5m);
      if (p) main5mWriteSavingsUsd += cacheWriteCostUsd(m, p) - cacheWriteCostUsd(writes5m, p);
    }
    // A read that survived a (5m, 60m] gap only hit because the prefix was on the 1h tier.
    if (m.gapMs !== null && m.gapMs > 5 * 60 * 1000 && m.gapMs <= 60 * 60 * 1000 && m.cacheReadTokens > 0) {
      main5mBreakEvenGapsCount++;
      main5mSavingsCredits -= m.cacheReadTokens * (CREDIT_WEIGHTS.cacheWrite - CREDIT_WEIGHTS.cacheRead);
      if (p) main5mExpiryPenaltiesUsd += (m.cacheReadTokens * (p.cacheWritePerMillion - p.cacheReadPerMillion)) / 1_000_000;
    }
  }

  const net5mSavingsUsd = main5mWriteSavingsUsd - main5mExpiryPenaltiesUsd;
  simulations.push({
    policyId: "main_5m_ttl",
    title: "Switch main session to 5m TTL",
    weeklySavingsUsd: net5mSavingsUsd / windowWeeks,
    totalSavingsUsd: net5mSavingsUsd,
    weeklySavingsCredits: main5mSavingsCredits / windowWeeks,
    assumptions: [
      "5m cache write = 1.25x input price; 1h cache write = 2.0x input price; cache read = 0.1x",
      "Write savings apply only to tokens billed at the 1h tier (usage.cache_creation.ephemeral_1h_input_tokens)",
      `Gaps in (5m, 60m] observed: ${main5mBreakEvenGapsCount}`,
      net5mSavingsUsd > 0
        ? "Fast-paced turns dominate; 37.5% write savings outweigh the few 5m-60m expiry rebuilds"
        : net5mSavingsUsd < 0
          ? "Negative savings: 1h TTL avoids rebuilds on 5m-60m pauses, so switching would cost more"
          : "No net dollar savings can be estimated in this window",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - net5mSavingsUsd,
  });

  let compactBeforeBreakSavingsUsd = 0;
  let compactBeforeBreakSavingsCredits = 0;
  let breaksCount = 0;

  for (const m of mainMissItems) {
    if (m.type === "expiry" && m.prevContextTokens > 20000) {
      breaksCount++;
      const compactedContext = 15000;
      const tokensSaved = Math.max(0, m.rebuildPrefixTokens - compactedContext);
      const writeCreditsPerToken = cacheWriteCredits(m) / m.cacheWriteTokens;
      const rebuildSavedCredits = tokensSaved * (writeCreditsPerToken - CREDIT_WEIGHTS.cacheRead);
      const compactCostCredits = m.prevContextTokens * CREDIT_WEIGHTS.cacheRead + 1000 * CREDIT_WEIGHTS.output;
      const netCredits = rebuildSavedCredits - compactCostCredits;
      if (netCredits > 0) compactBeforeBreakSavingsCredits += netCredits;
      const p = getPricing(m.model);
      if (p) {
        const writePerToken = cacheWriteCostUsd(m, p) / m.cacheWriteTokens;
        const rebuildSavedUsd = tokensSaved * (writePerToken - p.cacheReadPerMillion / 1_000_000);
        const compactCostUsd = (m.prevContextTokens * p.cacheReadPerMillion + 1000 * p.outputPerMillion) / 1_000_000;
        const net = rebuildSavedUsd - compactCostUsd;
        if (net > 0) compactBeforeBreakSavingsUsd += net;
      }
    }
  }

  simulations.push({
    policyId: "compact_before_breaks",
    title: "Run /compact before breaks > 1 hour",
    weeklySavingsUsd: compactBeforeBreakSavingsUsd / windowWeeks,
    totalSavingsUsd: compactBeforeBreakSavingsUsd,
    weeklySavingsCredits: compactBeforeBreakSavingsCredits / windowWeeks,
    assumptions: [
      `Detected ${breaksCount} long breaks (>1h) on large context (>20k tokens)`,
      "Compaction reduces context to ~15k tokens before idle expiry, drastically lowering rebuild size upon return",
      "Compaction cost modeled on warm prefix read (0.1x) + 1,000 output tokens",
      "Counts the same expiries as the fresh-session sim; the two savings are not additive",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - compactBeforeBreakSavingsUsd,
  });

  let autoCompactSavingsUsd = 0;
  let autoCompactSavingsCredits = 0;
  for (const m of mainMissItems) {
    if (m.contextTokens > 70000) {
      const excess = m.contextTokens - 70000;
      autoCompactSavingsCredits += excess * 0.4 * CREDIT_WEIGHTS.cacheRead;
      const p = getPricing(m.model);
      if (p) {
        autoCompactSavingsUsd += (excess * 0.4 * p.cacheReadPerMillion) / 1_000_000;
      }
    }
  }

  simulations.push({
    policyId: "auto_compact_35pct",
    title: "Lower auto-compact threshold to 35% of context window",
    weeklySavingsUsd: autoCompactSavingsUsd / windowWeeks,
    totalSavingsUsd: autoCompactSavingsUsd,
    weeklySavingsCredits: autoCompactSavingsCredits / windowWeeks,
    assumptions: [
      "Caps context near 70k tokens, reducing ongoing read token volume across long sessions",
      "Net savings account for ~40% reduced per-turn read context in deep sessions",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - autoCompactSavingsUsd,
  });

  let freshSessionSavingsUsd = 0;
  let freshSessionSavingsCredits = 0;
  let staleResumesCount = 0;

  for (const m of mainMissItems) {
    if (m.type === "expiry" && m.gapMs !== null && m.gapMs > 24 * 60 * 60 * 1000 && m.prevContextTokens > 30000) {
      staleResumesCount++;
      const savedWrite = Math.max(0, m.prevContextTokens - 15000);
      const writeCreditsPerToken = cacheWriteCredits(m) / m.cacheWriteTokens;
      freshSessionSavingsCredits += savedWrite * (writeCreditsPerToken - CREDIT_WEIGHTS.cacheRead);
      const p = getPricing(m.model);
      if (p) {
        const writePerToken = cacheWriteCostUsd(m, p) / m.cacheWriteTokens;
        freshSessionSavingsUsd += savedWrite * (writePerToken - p.cacheReadPerMillion / 1_000_000);
      }
    }
  }

  simulations.push({
    policyId: "fresh_session_vs_stale",
    title: "Start a fresh session instead of resuming after > 24h",
    weeklySavingsUsd: freshSessionSavingsUsd / windowWeeks,
    totalSavingsUsd: freshSessionSavingsUsd,
    weeklySavingsCredits: freshSessionSavingsCredits / windowWeeks,
    assumptions: [
      `Detected ${staleResumesCount} session continuations after > 24h pause on large context`,
      "Starting fresh eliminates full rebuild of expired historic context and lowers subsequent turn volume",
      "Overlaps the compact-before-breaks sim on the same expiries; the two savings are not additive",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - freshSessionSavingsUsd,
  });

  const rankedSimulations = [
    simulations[0]!,
    ...simulations.slice(1).sort((a, b) => b.weeklySavingsUsd - a.weeklySavingsUsd),
  ];

  return {
    correctedHitPct,
    legacyHitPct,
    tokenMix,
    costMix,
    misses: {
      totalWrites: writesOnly.length,
      expiries: expiries.length,
      growths: growths.length,
      invalidations: invalidations.length,
      colds: colds.length,
      totalExpiryExtraCostUsd,
      totalExpiryExtraCredits,
      totalInvalidationExtraCostUsd,
      totalInvalidationExtraCredits,
      items: writesOnly,
    },
    subagentMisses: {
      totalTurns: subagentMissItems.length,
      coldStarts: subColdStarts.length,
      expiries: subExpiries.length,
      growths: subGrowths.length,
      invalidations: subInvalidations.length,
      totalExpiryExtraCostUsd: subExpiryCostUsd,
      totalExpiryExtraCredits: subExpiryCredits,
      totalInvalidationExtraCostUsd: subInvalidationCostUsd,
      totalInvalidationExtraCredits: subInvalidationCredits,
      items: subWritesOnly,
    },
    gapHistogram,
    simulations: rankedSimulations,
    windowWeeks,
    unpriced: { turns: unpricedTurns, tokens: unpricedTokens, models: [...unpricedModels].sort() },
    reconciliation: {
      turns: reconciledTurns,
      readerCostUsd,
      tokenPricedCostUsd,
      deltaUsd: readerCostUsd - tokenPricedCostUsd,
    },
  };
}

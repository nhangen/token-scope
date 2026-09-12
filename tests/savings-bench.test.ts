import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-bench.jsonl", import.meta.url).pathname;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

let reader: Reader;
beforeAll(() => { reader = createReader({ source: "jsonl", projectsDirs: [SPEND_DIR] }); });
afterAll(() => { reader.close(); });

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

const base = {
  since: 0, sinceStr: "all", json: true,
  ledgerPath: LEDGER, counterfactualModel: DEFAULT_COUNTERFACTUAL_MODEL,
};

// Fixture: one authoring run, two benchmark sweeps, one review pass.
//   author:600           100000 /  40000
//   bench:model-matrix  1500000 /  30000
//   bench:model-matrix   500000 /  10000
//   review:600:p1of2      40000 /   2000
const AUTHOR_IN = 100000, AUTHOR_OUT = 40000;
const BENCH_IN = 2000000, BENCH_OUT = 40000;

describe("renderSavingsReport — benchmark sweeps are not delegation savings", () => {
  it("excludes bench: rows from the counterfactual", () => {
    // A benchmark sweep has no Claude counterfactual — nobody would have paid
    // Opus to generate benchmark completions across a model grid. Pricing it
    // invents a saving that was never available.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    // 40,000 uncached @ $5/M + 60,000 cached @ $0.50/M + 40,000 out @ $25/M = 1.23.
    // Hand-computed, not built from valueAtClaudePrices — these assertions used to
    // call the production pricing helper, so when #465 changed how input is priced
    // every one of them moved with it and none reported the change. See the
    // per-fixture derivation in the comment above each literal.
    expect(s.counterfactual_usd).toBeCloseTo(1.23, 6);
  });

  it("reports bench volume separately, per session and in totals", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.bench_run_count).toBe(2);
    expect(s.bench_input).toBe(BENCH_IN);
    expect(s.bench_output).toBe(BENCH_OUT);
    expect(p.totals.bench_run_count).toBe(2);
    expect(p.totals.bench_input).toBe(BENCH_IN);
    expect(p.totals.bench_output).toBe(BENCH_OUT);
  });

  it("keeps total token volume intact — the compute really happened", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.ollama_input).toBe(AUTHOR_IN + BENCH_IN + 40000);
    expect(s.run_count).toBe(4);
  });

  it("does not count a bench row as review, or a review row as bench", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.review_run_count).toBe(1);
    expect(s.review_input).toBe(40000);
    expect(s.bench_run_count).toBe(2);
  });

  it("labels bench rows by their second segment like any other phase", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, byLabel: true })));
    const mm = p.by_label.find((x: any) => x.label === "model-matrix");
    expect(mm).toBeDefined();
    expect(mm.run_count).toBe(2);
    expect(mm.bench_input).toBe(BENCH_IN);
    expect(mm.bench_output).toBe(BENCH_OUT);
    // Benchmark volume is not authoring volume, so it must not be priced here
    // either — otherwise --by-label contradicts the totals it sits above.
    expect(mm.author_input).toBe(0);
    expect(mm.counterfactual_usd).toBe(0);
  });

  it("names bench volume in the text report", () => {
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false }));
    expect(text.toLowerCase()).toContain("benchmark");
  });

  it("accounts for benchmark token volume by label in the text report", () => {
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false, byLabel: true }));
    expect(text).toContain("model-matrix: benchmark 2 run(s) in=2,000,000 out=40,000");
  });

  it("wraps the excluded-volume footnote losslessly to the terminal display width", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-savings-label-wrap-"));
    const ledger = join(dir, "runs.jsonl");
    const modifierGrapheme = "👍🏽";
    const zwjGrapheme = "👩‍💻";
    const longLabel = `${"界".repeat(37)}${modifierGrapheme}${zwjGrapheme}${"A".repeat(140)}`;
    const rows = readFileSync(LEDGER, "utf8").trimEnd();
    const extra = rows.split("\n")[1]!.replace("bench:model-matrix", `bench:${longLabel}`);
    writeFileSync(ledger, `${rows}\n${extra}\n`);
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 40 });
    try {
      const text = capture(() => renderSavingsReport(reader, { ...base, ledgerPath: ledger, json: false, byLabel: true }));
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 1 });
      const narrowText = capture(() => renderSavingsReport(reader, { ...base, ledgerPath: ledger, json: false, byLabel: true }));
      const fallbackWidths = [
        () => { delete (process.stdout as unknown as { columns?: number }).columns; },
        () => { Object.defineProperty(process.stdout, "columns", { configurable: true, value: "wide" }); },
        () => { Object.defineProperty(process.stdout, "columns", { configurable: true, value: 0 }); },
      ];
      const fallbackTexts = fallbackWidths.map((setWidth) => {
        setWidth();
        return capture(() => renderSavingsReport(reader, { ...base, ledgerPath: ledger, json: false, byLabel: true }));
      });
      const lines = text.split("\n").map(stripAnsi);
      const start = lines.findIndex((line) => line.includes("By Label Author In/Out"));
      const end = lines.findIndex((line, index) => index > start && line.trim() === "Totals");
      const exclusionLines = lines.slice(start, end).filter(Boolean);
      const firstLabel = exclusionLines.findIndex((line) => line.startsWith("    model-matrix:"));
      const headingLines = exclusionLines.slice(0, firstLabel);
      const wrappedStart = exclusionLines.findIndex((line) => line.startsWith(`    ${"界".repeat(8)}`));
      const wrapped = exclusionLines.slice(wrappedStart);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(headingLines.map((line, index) => line.slice(index === 0 ? 2 : 4)).join(""))
        .toBe("* By Label Author In/Out and Counterfact.* omit excluded volume:");
      expect(wrappedStart).toBeGreaterThan(-1);
      expect(exclusionLines.every((line) => Bun.stringWidth(line) <= 40)).toBe(true);
      expect(wrapped[0]).toBe(`    ${"界".repeat(18)}`);
      expect(wrapped.some((line) => line.startsWith("      🏽"))).toBe(false);
      expect(wrapped.filter((line) => line.includes(modifierGrapheme))).toHaveLength(1);
      expect(wrapped.filter((line) => line.includes(zwjGrapheme))).toHaveLength(1);
      expect(wrapped.map((line, index) => line.slice(index === 0 ? 4 : 6)).join(""))
        .toBe(`${longLabel}: benchmark 1 run(s) in=1,500,000 out=30,000.`);

      const narrowLines = narrowText.split("\n").map(stripAnsi);
      const narrowEnd = narrowLines.findIndex((line) => line.trim() === "Totals");
      const narrowSectionEnd = narrowLines.slice(0, narrowEnd).lastIndexOf("");
      const narrowStart = narrowLines.slice(0, narrowSectionEnd).lastIndexOf("") + 1;
      const narrowExclusionLines = narrowLines.slice(narrowStart, narrowSectionEnd).filter(Boolean);
      expect(narrowStart).toBeGreaterThan(0);
      expect(narrowSectionEnd).toBeGreaterThan(narrowStart);
      expect(narrowExclusionLines.every((line) =>
        Bun.stringWidth(line) <= 1 || [...GRAPHEME_SEGMENTER.segment(line)].length === 1,
      )).toBe(true);
      expect(narrowExclusionLines.some((line) => Bun.stringWidth(line) === 2)).toBe(true);

      for (const fallbackText of fallbackTexts) {
        const fallbackLines = fallbackText.split("\n").map(stripAnsi);
        const fallbackStart = fallbackLines.findIndex((line) => line.includes("By Label Author In/Out"));
        const fallbackEnd = fallbackLines.findIndex((line, index) => index > fallbackStart && line.trim() === "Totals");
        const fallbackExclusionLines = fallbackLines.slice(fallbackStart, fallbackEnd).filter(Boolean);
        expect(fallbackExclusionLines.every((line) => Bun.stringWidth(line) <= 80)).toBe(true);
        expect(fallbackExclusionLines.some((line) => Bun.stringWidth(line) > 40)).toBe(true);
      }
    } finally {
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete (process.stdout as unknown as { columns?: number }).columns;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent on a ledger with no bench rows", () => {
    const clean = new URL("./fixtures/ledger/runs-labelled.jsonl", import.meta.url).pathname;
    const text = capture(() => renderSavingsReport(reader, { ...base, ledgerPath: clean, json: false, byLabel: true }));
    expect(text.toLowerCase()).not.toContain("benchmark");
    expect(text).not.toContain("omit excluded volume:");
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, ledgerPath: clean })));
    expect(p.totals.bench_run_count).toBeUndefined();
  });
});

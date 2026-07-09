import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { parseArgs, parseTurnRange } from "@/cli";

const origExit = process.exit;
const origWrite = process.stderr.write.bind(process.stderr);

let lastExitCode: number | undefined;
let stderrBuf: string;

function installFakes() {
  lastExitCode = undefined;
  stderrBuf = "";
  process.exit = ((code?: number): never => {
    lastExitCode = code;
    throw new Error(`__exit_${code}`);
  }) as never;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderrBuf += String(chunk);
    return true;
  }) as typeof process.stderr.write;
}

function restoreFakes() {
  process.exit = origExit;
  process.stderr.write = origWrite;
}

describe("parseArgs --artifact-format validation", () => {
  beforeEach(installFakes);
  afterEach(restoreFakes);

  it("accepts a known format", () => {
    const args = parseArgs(["--artifact-format", "md"]);
    expect(args.artifactFormat).toBe("md");
    expect(args.mode).toBe("artifacts");
  });

  it("rejects an unknown format", () => {
    expect(() => parseArgs(["--artifact-format", "mdx"])).toThrow("__exit_1");
    expect(lastExitCode).toBe(1);
    expect(stderrBuf).toContain("must be one of");
  });

  it("rejects an empty value", () => {
    expect(() => parseArgs(["--artifact-format"])).toThrow("__exit_1");
    expect(lastExitCode).toBe(1);
  });
});

describe("parseArgs mode-conflict guard", () => {
  beforeEach(installFakes);
  afterEach(restoreFakes);

  it("errors when --artifact-format paired with --tools", () => {
    expect(() => parseArgs(["--tools", "--artifact-format", "md"])).toThrow("__exit_1");
    expect(lastExitCode).toBe(1);
    expect(stderrBuf).toContain("only valid with --artifacts");
  });

  it("errors when --artifact-path paired with --thinking", () => {
    expect(() => parseArgs(["--thinking", "--artifact-path", "foo"])).toThrow("__exit_1");
    expect(lastExitCode).toBe(1);
  });

  it("allows --artifact-format with --artifact-show", () => {
    const args = parseArgs(["--artifact-show", "/x/y.md", "--artifact-format", "md"]);
    expect(args.mode).toBe("artifact-show");
    expect(args.artifactFormat).toBe("md");
  });
});

describe("parseArgs --savings", () => {
  beforeEach(installFakes);
  afterEach(restoreFakes);

  it("sets savings mode", () => {
    expect(parseArgs(["--savings"]).mode).toBe("savings");
  });

  it("consumes --session as a scoping arg (both flag orders)", () => {
    const a = parseArgs(["--savings", "--session", "abc123"]);
    expect(a.mode).toBe("savings");
    expect(a.sessionId).toBe("abc123");
    const b = parseArgs(["--session", "abc123", "--savings"]);
    expect(b.mode).toBe("savings");
    expect(b.sessionId).toBe("abc123");
  });

  it("accepts --ledger and --counterfactual-model with --savings", () => {
    const a = parseArgs(["--savings", "--ledger", "/l.jsonl", "--counterfactual-model", "claude-sonnet-5"]);
    expect(a.ledgerPath).toBe("/l.jsonl");
    expect(a.counterfactualModel).toBe("claude-sonnet-5");
  });

  it("rejects --ledger without --savings", () => {
    expect(() => parseArgs(["--ledger", "/l.jsonl"])).toThrow("__exit_1");
    expect(stderrBuf).toContain("only valid with --savings");
  });

  it("rejects --counterfactual-model without --savings", () => {
    expect(() => parseArgs(["--counterfactual-model", "claude-opus-4-8"])).toThrow("__exit_1");
    expect(lastExitCode).toBe(1);
  });

  it("rejects --turns with --savings (spend-only)", () => {
    expect(() => parseArgs(["--savings", "--turns", "1..3"])).toThrow("__exit_1");
    expect(stderrBuf).toContain("only valid with --spend");
  });

  it("accepts --pm-turns with --savings + --session", () => {
    const a = parseArgs(["--savings", "--session", "abc123", "--pm-turns", "3..7"]);
    expect(a.pmTurnRange).toEqual({ from: 3, to: 7 });
  });

  it("rejects --pm-turns without --savings", () => {
    expect(() => parseArgs(["--pm-turns", "1..3"])).toThrow("__exit_1");
    expect(stderrBuf).toContain("only valid with --savings");
  });

  it("rejects --pm-turns without --session", () => {
    expect(() => parseArgs(["--savings", "--pm-turns", "1..3"])).toThrow("__exit_1");
    expect(stderrBuf).toContain("requires --session");
  });
});

describe("parseTurnRange", () => {
  it("parses a single turn N as N..N", () => {
    expect(parseTurnRange("5")).toEqual({ from: 5, to: 5 });
  });
  it("parses a bounded range N..M", () => {
    expect(parseTurnRange("3..8")).toEqual({ from: 3, to: 8 });
  });
  it("parses an open-ended range N..", () => {
    expect(parseTurnRange("4..")).toEqual({ from: 4, to: undefined });
  });
  it("parses a leading-open range ..M", () => {
    expect(parseTurnRange("..6")).toEqual({ from: undefined, to: 6 });
  });
  it("rejects a reversed range", () => {
    expect(() => parseTurnRange("8..3")).toThrow();
  });
  it("rejects zero", () => {
    expect(() => parseTurnRange("0")).toThrow();
  });
  it("rejects non-numeric", () => {
    expect(() => parseTurnRange("x..y")).toThrow();
  });
  it("rejects an empty range", () => {
    expect(() => parseTurnRange("..")).toThrow();
  });
});

describe("parseArgs --spend / --turns", () => {
  beforeEach(installFakes);
  afterEach(restoreFakes);

  it("--spend sets spend mode", () => {
    expect(parseArgs(["--spend"]).mode).toBe("spend");
  });

  it("--turns with --spend captures the range", () => {
    const args = parseArgs(["--spend", "--turns", "2..4"]);
    expect(args.mode).toBe("spend");
    expect(args.turnRange).toEqual({ from: 2, to: 4 });
  });

  it("--turns without --spend errors", () => {
    expect(() => parseArgs(["--turns", "2..4"])).toThrow("__exit_1");
    expect(lastExitCode).toBe(1);
    expect(stderrBuf).toContain("only valid with --spend");
  });

  it("--turns with a bad value errors", () => {
    expect(() => parseArgs(["--spend", "--turns", "9..1"])).toThrow("__exit_1");
    expect(lastExitCode).toBe(1);
  });

  it("--spend accepts --session", () => {
    const args = parseArgs(["--spend", "--session", "abc123"]);
    expect(args.mode).toBe("spend");
    expect(args.sessionId).toBe("abc123");
  });
});

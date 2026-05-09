import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { parseArgs } from "@/cli";

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

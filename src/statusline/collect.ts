#!/usr/bin/env bun
import { appendSnapshot, promptCacheLogPath, sanitizePayload } from "@/prompt-cache";

/**
 * Status-line collector: reads the status-line JSON on stdin, persists the allowlisted
 * `prompt_cache` telemetry, and prints nothing so it can sit in front of a real status line.
 * It never exits non-zero; a failing collector must not break the status line.
 */
async function main(): Promise<void> {
  try {
    const raw = await Bun.stdin.text();
    const snap = sanitizePayload(JSON.parse(raw), Math.floor(Date.now() / 1000));
    if (snap) appendSnapshot(promptCacheLogPath(), snap);
  } catch (err) {
    // Exit 0 regardless; the error class (never the payload) goes to stderr so a dead collector is diagnosable.
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name ?? "Error";
    process.stderr.write(`token-scope collector: not recorded (${code})\n`);
  }
}

await main();

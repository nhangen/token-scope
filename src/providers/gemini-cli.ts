/**
 * Gemini CLI 0.44.1 local session JSONL contract.
 *
 * Gemini CLI owns authentication and may itself use Google sign-in, an API
 * key, or Vertex AI. Its session record does not identify that choice, a cash
 * charge, or quota utilization. This adapter reads only chat records and keeps
 * those values unknown instead of deriving them from token counts.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { privateSafeEventId, qualifiedProviderId, type ProviderEvent } from "./types";

export const GEMINI_CLI_SOURCE_CONTRACT = Object.freeze({
  surface: "gemini-cli-session-jsonl",
  testedVersion: "0.44.1",
  dataLocation: "~/.gemini/tmp/<project>/chats/**/*.jsonl",
  apiContract: "final type=gemini message per durable id; tokens.input is promptTokenCount, including cached and tool-use prompt tokens; normalized input is input minus cached",
  authenticationBoundary: "Gemini CLI owns authentication; TokenScope reads session JSONL only",
  access: "read-only",
} as const);

export const UNSUPPORTED_GOOGLE_SURFACES = Object.freeze([
  "google-ai-api",
  "vertex-ai",
] as const);

export type GeminiCliSourceReason =
  | "missing"
  | "unreadable"
  | "malformed"
  | "partial_records"
  | "unsafe_path"
  | null;

export interface GeminiCliSourceObservation {
  surface: typeof GEMINI_CLI_SOURCE_CONTRACT.surface;
  state: "available" | "partial" | "unavailable";
  reason: GeminiCliSourceReason;
  testedVersion: typeof GEMINI_CLI_SOURCE_CONTRACT.testedVersion;
  dataLocation: typeof GEMINI_CLI_SOURCE_CONTRACT.dataLocation;
  authenticationBoundary: typeof GEMINI_CLI_SOURCE_CONTRACT.authenticationBoundary;
  access: typeof GEMINI_CLI_SOURCE_CONTRACT.access;
}

export interface GeminiCliTranscriptResult {
  events: ProviderEvent[];
  errors: number;
  partialRecords: number;
}

export interface GeminiCliCollection {
  events: ProviderEvent[];
  skipped: number;
  partialFiles: number;
  affectedFiles: number;
  source: GeminiCliSourceObservation;
}

interface GeminiTokens {
  input?: unknown;
  output?: unknown;
  cached?: unknown;
  thoughts?: unknown;
  tool?: unknown;
}

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function containedBy(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function readRegularFile(path: string, sinceMs?: number): string | null {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Gemini session source is not a regular file");
    if (sinceMs !== undefined && stat.mtimeMs < sinceMs) return null;
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function source(
  state: GeminiCliSourceObservation["state"],
  reason: GeminiCliSourceReason,
): GeminiCliSourceObservation {
  return {
    surface: GEMINI_CLI_SOURCE_CONTRACT.surface,
    state,
    reason,
    testedVersion: GEMINI_CLI_SOURCE_CONTRACT.testedVersion,
    dataLocation: GEMINI_CLI_SOURCE_CONTRACT.dataLocation,
    authenticationBoundary: GEMINI_CLI_SOURCE_CONTRACT.authenticationBoundary,
    access: GEMINI_CLI_SOURCE_CONTRACT.access,
  };
}

function applyMessages(messages: Map<string, Record<string, unknown>>, value: unknown): void {
  if (!Array.isArray(value)) return;
  messages.clear();
  for (const message of value) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (typeof record.id === "string" && record.id) messages.set(record.id, record);
  }
}

export function geminiCliEventsFromTranscript(
  text: string,
  provenance: string,
): GeminiCliTranscriptResult {
  const messages = new Map<string, Record<string, unknown>>();
  let sessionId: string | null = null;
  let errors = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        errors += 1;
        continue;
      }
      record = parsed as Record<string, unknown>;
    } catch {
      errors += 1;
      continue;
    }

    if (typeof record.sessionId === "string" && record.sessionId) {
      sessionId = record.sessionId;
      applyMessages(messages, record.messages);
    }

    if (typeof record.$rewindTo === "string") {
      let found = false;
      let remove = false;
      for (const id of [...messages.keys()]) {
        if (id === record.$rewindTo) {
          found = true;
          remove = true;
        }
        if (remove) messages.delete(id);
      }
      if (!found) messages.clear();
      continue;
    }

    if (typeof record.$set === "object" && record.$set !== null && !Array.isArray(record.$set)) {
      applyMessages(messages, (record.$set as Record<string, unknown>).messages);
      continue;
    }

    if (typeof record.id === "string" && record.id) messages.set(record.id, record);
  }

  if (sessionId === null) errors += 1;

  const events: ProviderEvent[] = [];
  let partialRecords = 0;
  for (const [messageId, message] of messages) {
    if (message.type !== "gemini") continue;
    const missingTokens = message.tokens === undefined || message.tokens === null;
    if (!missingTokens && (typeof message.tokens !== "object" || Array.isArray(message.tokens))) {
      errors += 1;
      continue;
    }

    const tokens = missingTokens ? null : message.tokens as GeminiTokens;
    const promptInput = token(tokens?.input);
    const cached = token(tokens?.cached);
    const output = token(tokens?.output);
    const reasoning = token(tokens?.thoughts);

    let input: number | null = null;
    if (promptInput !== null && cached !== null) {
      const disjointInput = promptInput - cached;
      if (cached <= promptInput && Number.isSafeInteger(disjointInput)) input = disjointInput;
      else errors += 1;
    }

    const model = typeof message.model === "string" && message.model ? message.model : null;
    const timestamp = typeof message.timestamp === "string" && message.timestamp
      ? message.timestamp
      : null;
    if (
      input === null || cached === null || output === null || reasoning === null ||
      model === null || timestamp === null
    ) {
      partialRecords += 1;
    }
    const requestId = qualifiedProviderId("gemini-cli", messageId);
    const qualifiedSessionId = qualifiedProviderId("gemini-cli", sessionId);
    const rejectedRequestId = messageId.length > 0 && requestId === null;
    const rejectedSessionId = sessionId !== null && qualifiedSessionId === null;

    events.push({
      eventId: privateSafeEventId("gemini-cli", messageId),
      harness: "gemini-cli",
      billingRoute: "unknown",
      modelProvider: "google",
      model,
      ts: timestamp,
      status: rejectedRequestId || rejectedSessionId ? "incomplete" : "ok",
      partial: rejectedRequestId || rejectedSessionId,
      retryOf: null,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cached,
      cacheWriteTokens: null,
      reasoningTokens: reasoning,
      cashChargeUsd: null,
      provenance,
      requestId,
      runId: null,
      sessionId: qualifiedSessionId,
    });
  }

  return { events, errors, partialRecords };
}

export function geminiCliEvents(root: string, sinceMs?: number): GeminiCliCollection {
  const configuredRoot = resolve(root);
  let rootStat;
  try {
    rootStat = lstatSync(configuredRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 0, source: source("available", null) };
    }
    return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unreadable") };
  }
  if (rootStat.isSymbolicLink()) {
    return { events: [], skipped: 1, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unsafe_path") };
  }
  if (!rootStat.isDirectory()) {
    return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unreadable") };
  }

  const tmpRoot = join(configuredRoot, "tmp");
  let tmpStat;
  try {
    tmpStat = lstatSync(tmpRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 0, source: source("available", null) };
    }
    return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unreadable") };
  }
  if (tmpStat.isSymbolicLink()) {
    return { events: [], skipped: 1, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unsafe_path") };
  }
  if (!tmpStat.isDirectory()) {
    return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unreadable") };
  }

  let resolvedRoot: string;
  let resolvedTmpRoot: string;
  try {
    resolvedRoot = realpathSync(configuredRoot);
    resolvedTmpRoot = realpathSync(tmpRoot);
    if (!containedBy(resolvedRoot, resolvedTmpRoot)) {
      return { events: [], skipped: 1, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unsafe_path") };
    }
  } catch {
    return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 1, source: source("unavailable", "unreadable") };
  }

  const files: string[] = [];
  const affectedPaths = new Set<string>();
  let unreadable = false;
  let unsafePaths = 0;
  const walk = (dir: string, scope: "tmp" | "project" | "chats"): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable = true;
      affectedPaths.add(dir);
      return;
    }
    for (const entry of entries) {
      if (scope === "project" && entry.name !== "chats") continue;
      const path = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        unreadable = true;
        affectedPaths.add(path);
        continue;
      }
      if (scope === "tmp" && !stat.isDirectory() && !stat.isSymbolicLink()) continue;
      if (stat.isSymbolicLink()) {
        unsafePaths += 1;
        affectedPaths.add(path);
        continue;
      }
      if (scope === "project" && !stat.isDirectory()) {
        unsafePaths += 1;
        affectedPaths.add(path);
        continue;
      }
      if (scope === "chats" && !stat.isDirectory() && !stat.isFile()) {
        unsafePaths += 1;
        affectedPaths.add(path);
        continue;
      }
      if (
        scope === "chats" && stat.isFile() && entry.name.endsWith(".jsonl") &&
        sinceMs !== undefined && stat.mtimeMs < sinceMs
      ) {
        continue;
      }
      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(path);
      } catch {
        unreadable = true;
        affectedPaths.add(path);
        continue;
      }
      if (!containedBy(resolvedRoot, resolvedPath) || !containedBy(resolvedTmpRoot, resolvedPath)) {
        unsafePaths += 1;
        affectedPaths.add(path);
        continue;
      }
      if (scope === "tmp") {
        walk(resolvedPath, "project");
        continue;
      }
      if (scope === "project") {
        walk(resolvedPath, "chats");
        continue;
      }
      if (stat.isDirectory()) {
        walk(resolvedPath, "chats");
        continue;
      }
      if (entry.name.endsWith(".jsonl")) {
        files.push(resolvedPath);
      }
    }
  };
  walk(resolvedTmpRoot, "tmp");

  if (unreadable && files.length === 0 && unsafePaths === 0) {
    return { events: [], skipped: 0, partialFiles: 0, affectedFiles: affectedPaths.size, source: source("unavailable", "unreadable") };
  }
  if (files.length === 0 && unsafePaths === 0) {
    return { events: [], skipped: 0, partialFiles: 0, affectedFiles: 0, source: source("available", null) };
  }

  const events: ProviderEvent[] = [];
  let skipped = unsafePaths;
  let partialFiles = 0;
  let malformed = unreadable;
  for (const file of files.sort()) {
    try {
      const text = readRegularFile(file, sinceMs);
      if (text === null) continue;
      const parsed = geminiCliEventsFromTranscript(text, file);
      events.push(...parsed.events);
      if (parsed.errors > 0) {
        skipped += 1;
        malformed = true;
        affectedPaths.add(file);
      }
      if (parsed.partialRecords > 0) {
        partialFiles += 1;
        affectedPaths.add(file);
      }
    } catch {
      skipped += 1;
      malformed = true;
      affectedPaths.add(file);
    }
  }
  const uniqueEvents = [...new Map(events.map((event) => [event.eventId, event])).values()];

  if (unsafePaths > 0) {
    return { events: uniqueEvents, skipped, partialFiles, affectedFiles: affectedPaths.size, source: source("partial", "unsafe_path") };
  }
  if (malformed) {
    return { events: uniqueEvents, skipped, partialFiles, affectedFiles: affectedPaths.size, source: source("partial", "malformed") };
  }
  if (partialFiles > 0) {
    return { events: uniqueEvents, skipped, partialFiles, affectedFiles: affectedPaths.size, source: source("partial", "partial_records") };
  }
  return { events: uniqueEvents, skipped, partialFiles, affectedFiles: 0, source: source("available", null) };
}

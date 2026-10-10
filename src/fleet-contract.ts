export const FLEET_SCHEMA_VERSION = "1.0" as const;

export type FleetRecordStatus =
  | "ok"
  | "error"
  | "incomplete"
  | "partial"
  | "unavailable"
  | "unknown";

export interface FleetProvenance {
  source: string;
  locator: string | null;
  collected_at: string;
  completeness: "complete" | "partial" | "unavailable";
}

interface FleetRecordFields {
  schema_version: typeof FLEET_SCHEMA_VERSION;
  record_id: string;
  run_id: string | null;
  session_id: string | null;
  request_id: string | null;
  prompt_origin_host: string | null;
  execution_host: string | null;
  router_host: string | null;
  backend_host: string | null;
  harness: string | null;
  provider: string | null;
  backend: string | null;
  model: string | null;
  status: FleetRecordStatus;
  provenance: FleetProvenance;
}

export interface FleetUsageEvent extends FleetRecordFields {
  record_type: "usage_event";
  timestamp: string | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    reasoning_tokens: number | null;
    cash_charge_usd: number | null;
  };
}

export interface FleetOperationalSnapshot extends FleetRecordFields {
  record_type: "operational_snapshot";
  timestamp: string;
  window: {
    start: string;
    end: string;
  };
  process_id: string | null;
  stale_after_ms: number | null;
  counters: Record<string, number | null>;
}

export type FleetRecord = FleetUsageEvent | FleetOperationalSnapshot;

const RECORD_STATUSES = new Set<FleetRecordStatus>([
  "ok",
  "error",
  "incomplete",
  "partial",
  "unavailable",
  "unknown",
]);

export const PRIVATE_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "credential",
  "credentials",
  "headers",
  "prompt",
  "prompt_text",
  "raw_authorization_headers",
  "terminal_content",
  "terminal_scrollback",
]);

const COMMON_KEYS = [
  "schema_version",
  "record_type",
  "record_id",
  "run_id",
  "session_id",
  "request_id",
  "prompt_origin_host",
  "execution_host",
  "router_host",
  "backend_host",
  "harness",
  "provider",
  "backend",
  "model",
  "timestamp",
  "status",
  "provenance",
] as const;

export function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = new Set(Object.keys(value));
  const wanted = new Set(expected);
  const extra = [...actual].filter((key) => !wanted.has(key)).sort(compareCodeUnits);
  const missing = [...wanted].filter((key) => !actual.has(key)).sort(compareCodeUnits);
  if (extra.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (extra.length > 0) parts.push(`unexpected: ${extra.join(", ")}`);
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    throw new Error(`${name} has unsupported or missing fields (${parts.join("; ")})`);
  }
}

function assertPrivacyBoundary(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPrivacyBoundary(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (PRIVATE_KEYS.has(normalized)) {
      throw new Error(`fleet records cannot contain private field ${key}`);
    }
    assertPrivacyBoundary(child);
  }
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name);
}

function qualifiedId(value: unknown, name: string): string | null {
  const id = nullableString(value, name);
  if (id === null) return null;
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`${name} must be source-qualified`);
  }
  return id;
}

function timestampValue(value: unknown, name: string): string {
  const timestamp = stringValue(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) {
    throw new Error(`${name} must be an RFC 3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(timestamp);
  const canonical = timestamp.includes(".") ? timestamp : timestamp.replace("Z", ".000Z");
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return timestamp;
}

function nullableMeasurement(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number or null`);
  }
  return value;
}

function nullableInteger(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer or null`);
  }
  return value;
}

const URL_USERINFO = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i;
const BARE_USERINFO = /^[^/?#:@]+:[^/?#@]*@/;
const CREDENTIAL_PARAM_SEGMENTS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "hmac",
  "idtoken",
  "jsessionid",
  "jwt",
  "key",
  "pass",
  "passwd",
  "password",
  "pwd",
  "refreshtoken",
  "secret",
  "sig",
  "signature",
  "token",
]);
// Unseparated compounds (apitoken, apikeys, privatekeypem) have no segment
// boundary to split on, so a denylist of whole segments alone fails open on them.
// No telemetry name contains these stems, so they match anywhere in a segment.
const CREDENTIAL_PARAM_STEMS = [
  "accesskey",
  "apikey",
  "authkey",
  "clientsecret",
  "credential",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "privkey",
  "secretkey",
];
// These stems do appear inside telemetry names (max_tokens, tokenizer, secretary),
// so they match only at the end of a segment.
const CREDENTIAL_PARAM_SUFFIXES = ["secret", "secrets", "signature", "token"];

// A token segment followed by one of these names a count or class, not a
// credential (tokenCount, token_type, maxTokens) — core telemetry for a token-accounting tool.
const TOKEN_TELEMETRY_QUALIFIERS = new Set(["budget", "count", "counts", "kind", "limit", "max", "total", "type", "usage"]);

function isCredentialSegment(segment: string, next: string | undefined): boolean {
  if (segment === "token" && next !== undefined && TOKEN_TELEMETRY_QUALIFIERS.has(next)) return false;
  return CREDENTIAL_PARAM_SEGMENTS.has(segment) ||
    CREDENTIAL_PARAM_STEMS.some((stem) => segment.includes(stem)) ||
    CREDENTIAL_PARAM_SUFFIXES.some((suffix) => segment.endsWith(suffix));
}

function hasCredentialSegment(name: string): boolean {
  const segments = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((segment) => segment.replace(/(?<!\d)\d+$/, ""));
  return segments.some((segment, index) => isCredentialSegment(segment, segments[index + 1]));
}

// The camelCase split catches tokenValue and apiKeyId, but it also breaks a
// mixed-case credential apart (pAssword -> p_assword), and case-insensitive
// servers read that as the real name, so the unsplit name is checked too.
export function isCredentialParam(name: string): boolean {
  return hasCredentialSegment(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2")) ||
    hasCredentialSegment(name);
}

// Each run of escapes decodes on its own, so one malformed % elsewhere in the
// locator cannot drop the whole string to byte-by-byte decoding, which splits
// UTF-8-encoded zero-width and fullwidth characters into harmless-looking bytes.
function decodeOnce(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
}

// Decoding before splitting keeps an encoded separator (%3B, %26, %2574) from
// hiding a name; NFKD and dropping marks, format, and control characters keep
// fullwidth letters, accents, zero-width spaces, and NUL from disguising or
// splitting one. Cross-script lookalikes (Cyrillic о) and Hangul fillers are not
// folded: they take deliberate evasion, not accidental leakage. Returns null for
// a locator still encoded after three passes.
export function decodeLocator(locator: string): string | null {
  let decoded = locator;
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (decodeOnce(decoded) !== decoded) return null;
  return decoded.normalize("NFKD").replace(/[\p{M}\p{Cc}\p{Cf}]/gu, "");
}

// Matrix params (;jsessionid=), name=value path segments, and values that embed
// another name= all carry names, so every run ending in = counts, wherever it
// sits. A bare name counts only where a query, fragment, or matrix param starts.
const LOCATOR_PARAM = /(?<=(^|[\s/;?&#,|=]))([^\s/;?&#,|=]+)(=?)/g;

export function locatorParams(decoded: string): string[] {
  const names: string[] = [];
  for (const [, delimiter = "", name = "", equals = ""] of decoded.matchAll(LOCATOR_PARAM)) {
    if (equals || (delimiter !== "" && "?&;#".includes(delimiter))) names.push(name);
  }
  return names;
}

// WHATWG URL parsing skips leading whitespace and control characters, treats
// "\\" as "/", and accepts any number of slashes after a special scheme, so
// "https:/user:pw@host" still carries userinfo the regexes alone miss.
export function hasUserinfo(locator: string): boolean {
  const authority = locator.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().replaceAll("\\", "/");
  if (URL_USERINFO.test(authority) || BARE_USERINFO.test(authority)) return true;
  try {
    const url = new URL(authority);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

export class PrivacyError extends Error {}

// Header-style "name: value" and spaced "name = value" pairs are not locator
// params, so they get their own pass over the fleet contract's credential names.
// An unspaced colon before a bare number, model size, or date is part of a
// qualified ID (auth-gw:40114, secret-model:7b, olla:auth-gw:2026-09-22...),
// not a name: value pair. Any other unspaced value still counts.
const SPACED_ASSIGNMENT = new RegExp(
  String.raw`([^\s/;?&#,|=:]+)\s*(?:=(?=\s*\S)|:(?=\s+\S|(?!\d+(?:\.\d+)*[bBkKmM]?(?:$|[\s/:?#,;&|=-]))\S))`,
  "g",
);
const EMBEDDED_USERINFO = /(?:^|[\s/])[^/?#@\s:]+:[^/?#@\s]*@/;
const BARE_CREDENTIAL = new RegExp([
  String.raw`\b(?:bearer|basic)[\s+:]+\S`,
  String.raw`\beyJ[\w-]{8,}\.[\w-]{8,}`,
  // The placeholder is a value a human wrote by hand: FAKE-EXAMPLE is exactly
  // the shape a real sk- key has minus length, so the gate must be length-free.
  String.raw`(?:^|[^a-z0-9])sk-[\w-]{6,}`,
  String.raw`\b(?:sk|rk|pk)_(?:live|test)_\w{8,}`,
  // ghp_/gho_/... and github_pat_ personal access tokens: FAKE-EXAMPLE is a
  // hand-written placeholder with the same shape as a real token minus
  // length, so the gate is length-free here too.
  String.raw`\bgh[pousr]_[\w-]{10,}`,
  String.raw`\bgithub_pat_[\w-]{10,}`,
  String.raw`\bA[SK]IA[0-9A-Z]{16}`,
  String.raw`\bglpat-[\w-]{10,}`,
  String.raw`\bxox[abposr]-[\w-]{10,}`,
].join("|"), "i");

const CREDENTIAL_PARAM_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "apitoken",
  "authkey",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "hmac",
  "idtoken",
  "jsessionid",
  "jwt",
  "passphrase",
  "passwd",
  "password",
  "privkey",
  "privatekey",
  "privatekeys",
  "pwd",
  "refreshtoken",
  "secret",
  "secretkey",
  "sessiontoken",
  "sig",
  "signature",
]);

function isCredentialPair(keyRaw: string, valRaw: string): boolean {
  const key = keyRaw.toLowerCase().replace(/[-_]/g, "");
  const val = valRaw.toLowerCase().replace(/^["\x27\[]+|["\x27\]]+$/g, "");

  if (CREDENTIAL_PARAM_KEYS.has(key)) {
    return true;
  }

  if (key === "token" || key === "tokens" || key.endsWith("token") || key.endsWith("tokens")) {
    const valStem = val.split(/[=:]/)[0] ?? val;
    if (TOKEN_TELEMETRY_QUALIFIERS.has(val) || TOKEN_TELEMETRY_QUALIFIERS.has(valStem)) return false;
    if (/^\d+(?:\.\d+)?$/.test(val)) return false;
    if (
      key.startsWith("input")
      || key.startsWith("output")
      || key.startsWith("prompt")
      || key.startsWith("completion")
      || key.startsWith("cache")
      || key.startsWith("max")
    ) {
      return false;
    }
    return true;
  }

  if (/(?:secret|secrets|password|passwd|sig|signature)$/.test(key)) {
    if (
      key.startsWith("sort")
      || key.startsWith("cache")
      || key.startsWith("public")
      || key.startsWith("primary")
      || key.startsWith("partition")
      || key.startsWith("routing")
    ) {
      return false;
    }
    return true;
  }

  // Compound keys: client_key, app_key, signing_key, etc.
  // Bare "key" alone (e.g. tag={"key": "env"}) and non-key words (monkey) are not credentials.
  if (
    /(?:^|[^a-z0-9])(?:[a-z0-9]+[-_]keys?)$/i.test(keyRaw)
    || /(?:api|access|auth|secret|priv|private|client|app|signing|encryption|master|ssh|deploy)keys?$/.test(key)
  ) {
    if (
      key.startsWith("sort")
      || key.startsWith("cache")
      || key.startsWith("public")
      || key.startsWith("primary")
      || key.startsWith("partition")
      || key.startsWith("routing")
    ) {
      return false;
    }
    return true;
  }

  return false;
}

// A locator path that names a credential class as a segment.
// A Slack-style webhook path (/services/T000/B000/<token>) is fully specified
// by the last segment, so it is one positional credential of its own.
// "token" and "tokens" are the only words the positional check rejects on
// their own, because they are the only credential words that also appear in
// telemetry names; the name scanner's qualifiers decide which token is which.
const CREDENTIAL_PATH_WORDS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "apitoken",
  "authkey",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "hmac",
  "idtoken",
  "jsessionid",
  "jwt",
  "passphrase",
  "passwd",
  "password",
  "privkey",
  "privatekey",
  "privatekeys",
  "pwd",
  "refreshtoken",
  "secret",
  "secrets",
  "secretkey",
  "sessiontoken",
  "sig",
  "signature",
  "token",
  "tokens",
]);

function isCredentialPathWord(norm: string): boolean {
  if (CREDENTIAL_PATH_WORDS.has(norm)) return true;
  if (norm.endsWith("token") || norm.endsWith("tokens")) {
    if (
      norm.startsWith("input")
      || norm.startsWith("output")
      || norm.startsWith("prompt")
      || norm.startsWith("completion")
      || norm.startsWith("cache")
    ) {
      return false;
    }
    return true;
  }
  if (
    /(?:secret|secrets|password|passwd)$/.test(norm)
    || /(?:api|access|auth|secret|priv|private|client|app|signing|encryption|master|ssh|deploy)keys?$/.test(norm)
  ) {
    if (
      norm.startsWith("sort")
      || norm.startsWith("cache")
      || norm.startsWith("public")
      || norm.startsWith("primary")
      || norm.startsWith("partition")
      || norm.startsWith("routing")
    ) {
      return false;
    }
    return true;
  }
  return false;
}

// "auth" names a mechanism (Authorization: Bearer <token>) and is not a
// credential class, and the adapter's base URL may legally end in it
// (an /auth or /oauth mount) — so it is a positional credential only with a
// value to carry it, which hasUserinfo already rejects.

const SLACK_WEBHOOK_PATH = /(?:^|\/)services(?:;[^/]*)?\/T[0-9A-Z]+(?:;[^/]*)?\/B[0-9A-Z]+(?:;[^/]*)?\/[^/?#\s]+/i;

function hasPositionalCredential(decoded: string): boolean {
  const normalized = decoded.replaceAll("\\", "/");
  const [pathPart = ""] = normalized.split(/[?#]/, 1);
  const pathMatch = pathPart.match(/^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#]+)?([^?#]*)/i);
  const pathname = pathMatch ? (pathMatch[1] ?? "") : pathPart;
  if (SLACK_WEBHOOK_PATH.test(pathname)) return true;

  const rawSegments = pathname.split("/").filter((s) => s.length > 0);
  for (let i = 0; i < rawSegments.length; i++) {
    const rawSegment = rawSegments[i];
    if (!rawSegment) continue;
    const segment = rawSegment.split(";")[0]?.trim() ?? "";
    if (!segment) continue;

    const colonParts = segment.split(/\s*:\s*/);
    if (colonParts.length > 1) {
      for (let j = 0; j < colonParts.length - 1; j++) {
        const k = colonParts[j] ?? "";
        const v = colonParts[j + 1] ?? "";
        if (isCredentialPair(k, v)) return true;
      }
    }

    const norm = segment.toLowerCase().replace(/[-_]/g, "");
    if (isCredentialPathWord(norm)) {
      if (i + 1 < rawSegments.length) {
        const nextRaw = rawSegments[i + 1];
        const nextSegment = (nextRaw ? nextRaw.split(";")[0]?.trim().toLowerCase() : "") ?? "";
        if (norm === "token" || norm === "tokens") {
          if (TOKEN_TELEMETRY_QUALIFIERS.has(nextSegment)) continue;
        }
        return true;
      }
    }
  }
  return false;
}

function hasCredentialValue(decoded: string): boolean {
  if (BARE_CREDENTIAL.test(decoded)) return true;

  const checkPair = (key: string, val: string): boolean => {
    if (isCredentialPair(key, val)) return true;
    if (val.includes(":")) {
      const parts = val.split(/\s*:\s*/);
      for (let j = 0; j < parts.length - 1; j++) {
        const nestedK = parts[j] ?? "";
        const nestedV = parts[j + 1] ?? "";
        if (isCredentialPair(nestedK, nestedV)) return true;
      }
    }
    return false;
  };

  const pattern = /["\x27]?([a-z0-9_-]+)["\x27]?\s*[:=]\s*["\x27]?([^\s,}"\x27&]+)/gi;
  for (const match of decoded.matchAll(pattern)) {
    const key = match[1];
    const val = match[2];
    if (key && val && checkPair(key, val)) return true;
  }

  // Parameter values scan specifically catches assignments like w=token:FAKE-EXAMPLE
  const params = decoded.split(/[&;?#]/);
  for (const param of params) {
    const eqIdx = param.indexOf("=");
    if (eqIdx === -1) continue;
    const paramVal = param.slice(eqIdx + 1);
    for (const match of paramVal.matchAll(pattern)) {
      const key = match[1];
      const val = match[2];
      if (key && val && checkPair(key, val)) return true;
    }
  }
  return false;
}

export function assertSafeLabelValue(value: string): void {
  const decoded = decodeLocator(value);
  if (
    decoded === null
    || hasUserinfo(decoded)
    || EMBEDDED_USERINFO.test(decoded)
    || BARE_CREDENTIAL.test(decoded)
    || locatorParams(decoded).some(isCredentialParam)
    || [...decoded.matchAll(SPACED_ASSIGNMENT)]
      .some((match) => isCredentialParam(match[1]!))
  ) {
    throw new PrivacyError("credential-like label value rejected");
  }
}

function locatorValue(value: unknown): string | null {
  const locator = nullableString(value, "provenance.locator");
  if (locator === null) return null;
  if (hasUserinfo(locator)) {
    throw new Error("provenance.locator cannot contain URL credentials");
  }
  const decoded = decodeLocator(locator);
  if (decoded === null || locatorParams(decoded).some(isCredentialParam)) {
    throw new Error("provenance.locator cannot contain credential query parameters");
  }
  if (hasPositionalCredential(decoded)) {
    throw new Error("provenance.locator cannot contain a positional credential segment");
  }
  if (hasCredentialValue(decoded)) {
    throw new Error("provenance.locator cannot carry a credential value");
  }
  return locator;
}

function provenanceValue(value: unknown): FleetProvenance {
  const provenance = objectValue(value, "provenance");
  assertExactKeys(provenance, ["source", "locator", "collected_at", "completeness"], "provenance");
  const completeness = provenance.completeness;
  if (completeness !== "complete" && completeness !== "partial" && completeness !== "unavailable") {
    throw new Error("provenance.completeness is invalid");
  }
  return {
    source: stringValue(provenance.source, "provenance.source"),
    locator: locatorValue(provenance.locator),
    collected_at: timestampValue(provenance.collected_at, "provenance.collected_at"),
    completeness,
  };
}

function commonFields(record: Record<string, unknown>): FleetRecordFields {
  if (record.schema_version !== FLEET_SCHEMA_VERSION) {
    throw new Error(`unsupported fleet schema version ${String(record.schema_version)}`);
  }
  if (!RECORD_STATUSES.has(record.status as FleetRecordStatus)) {
    throw new Error("status is invalid");
  }
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    record_id: stringValue(record.record_id, "record_id"),
    run_id: qualifiedId(record.run_id, "run_id"),
    session_id: qualifiedId(record.session_id, "session_id"),
    request_id: qualifiedId(record.request_id, "request_id"),
    prompt_origin_host: nullableString(record.prompt_origin_host, "prompt_origin_host"),
    execution_host: nullableString(record.execution_host, "execution_host"),
    router_host: nullableString(record.router_host, "router_host"),
    backend_host: nullableString(record.backend_host, "backend_host"),
    harness: nullableString(record.harness, "harness"),
    provider: nullableString(record.provider, "provider"),
    backend: nullableString(record.backend, "backend"),
    model: nullableString(record.model, "model"),
    status: record.status as FleetRecordStatus,
    provenance: provenanceValue(record.provenance),
  };
}

export function parseFleetRecord(value: unknown): FleetRecord {
  assertPrivacyBoundary(value);
  const record = objectValue(value, "fleet record");
  if (record.record_type === "usage_event") {
    assertExactKeys(record, [...COMMON_KEYS, "usage"], "usage event");
    const usage = objectValue(record.usage, "usage");
    assertExactKeys(usage, [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
      "cash_charge_usd",
    ], "usage");
    return {
      ...commonFields(record),
      record_type: "usage_event",
      timestamp: record.timestamp === null ? null : timestampValue(record.timestamp, "timestamp"),
      usage: {
        input_tokens: nullableInteger(usage.input_tokens, "usage.input_tokens"),
        output_tokens: nullableInteger(usage.output_tokens, "usage.output_tokens"),
        cache_read_tokens: nullableInteger(usage.cache_read_tokens, "usage.cache_read_tokens"),
        cache_write_tokens: nullableInteger(usage.cache_write_tokens, "usage.cache_write_tokens"),
        reasoning_tokens: nullableInteger(usage.reasoning_tokens, "usage.reasoning_tokens"),
        cash_charge_usd: nullableMeasurement(usage.cash_charge_usd, "usage.cash_charge_usd"),
      },
    };
  }
  if (record.record_type === "operational_snapshot") {
    assertExactKeys(
      record,
      [...COMMON_KEYS, "window", "process_id", "stale_after_ms", "counters"],
      "operational snapshot",
    );
    const timestamp = timestampValue(record.timestamp, "timestamp");
    const window = objectValue(record.window, "window");
    assertExactKeys(window, ["start", "end"], "window");
    const start = timestampValue(window.start, "window.start");
    const end = timestampValue(window.end, "window.end");
    if (Date.parse(start) >= Date.parse(end) || Date.parse(end) > Date.parse(timestamp)) {
      throw new Error("snapshot window must be non-empty and end no later than timestamp");
    }
    const counters = objectValue(record.counters, "counters");
    const parsedCounters: Record<string, number | null> = Object.create(null);
    for (const [name, counter] of Object.entries(counters).sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (!name) throw new Error("counter names cannot be empty");
      parsedCounters[name] = nullableMeasurement(counter, `counters.${name}`);
    }
    const common = commonFields(record);
    const expectedCompleteness =
      common.status === "partial" || common.status === "unavailable"
        ? common.status
        : "complete";
    if (common.provenance.completeness !== expectedCompleteness) {
      throw new Error("snapshot status and provenance completeness must agree");
    }
    return {
      ...common,
      record_type: "operational_snapshot",
      timestamp,
      window: { start, end },
      process_id: qualifiedId(record.process_id, "process_id"),
      stale_after_ms: nullableInteger(record.stale_after_ms, "stale_after_ms"),
      counters: parsedCounters,
    };
  }
  throw new Error(`unsupported fleet record type ${String(record.record_type)}`);
}

const CORRELATION_FIELDS = ["request_id", "run_id", "session_id"] as const;
type CorrelationField = (typeof CORRELATION_FIELDS)[number];

function correlationKey(field: CorrelationField, value: string): string {
  return `${field}=${value}`;
}

export function correlationKeys(record: FleetRecord): string[] {
  const keys: string[] = [];
  for (const field of CORRELATION_FIELDS) {
    const value = record[field];
    if (value !== null) keys.push(correlationKey(field, value));
  }
  return keys;
}

export function usageFallsInSnapshotWindow(
  usage: FleetUsageEvent,
  snapshot: FleetOperationalSnapshot,
): boolean | null {
  if (usage.timestamp === null) return null;
  const timestamp = Date.parse(usage.timestamp);
  return timestamp >= Date.parse(snapshot.window.start) && timestamp < Date.parse(snapshot.window.end);
}

export type FleetJoinResult =
  | { state: "matched"; key: string; snapshot: FleetOperationalSnapshot }
  | { state: "unmatched"; key: null; snapshot: null }
  | { state: "ambiguous"; key: string; snapshot: null };

export function joinUsageToSnapshots(
  usage: FleetUsageEvent,
  snapshots: FleetOperationalSnapshot[],
): FleetJoinResult {
  for (const field of CORRELATION_FIELDS) {
    const value = usage[field];
    if (value === null) continue;
    const matches = snapshots.filter(
      (snapshot) => snapshot[field] === value && usageFallsInSnapshotWindow(usage, snapshot) === true,
    );
    if (matches.length === 1) {
      return { state: "matched", key: correlationKey(field, value), snapshot: matches[0]! };
    }
    if (matches.length > 1) {
      return { state: "ambiguous", key: correlationKey(field, value), snapshot: null };
    }
  }
  return { state: "unmatched", key: null, snapshot: null };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function dedupeFleetRecords(records: FleetRecord[]): {
  records: FleetRecord[];
  conflicts: string[];
} {
  const byId = new Map<string, Map<string, FleetRecord>>();
  for (const record of records) {
    const variants = byId.get(record.record_id) ?? new Map<string, FleetRecord>();
    variants.set(canonicalJson(record), record);
    byId.set(record.record_id, variants);
  }
  const deduped: FleetRecord[] = [];
  const conflicts: string[] = [];
  for (const id of [...byId.keys()].sort(compareCodeUnits)) {
    const variants = byId.get(id)!;
    if (variants.size === 1) deduped.push(variants.values().next().value!);
    else conflicts.push(id);
  }
  return { records: deduped, conflicts };
}

export function classifySnapshotFreshness(
  snapshot: FleetOperationalSnapshot,
  evaluatedAt: string,
): "current" | "stale" | "unknown" {
  if (snapshot.stale_after_ms === null) return "unknown";
  const evaluatedMs = Date.parse(timestampValue(evaluatedAt, "evaluatedAt"));
  const age = evaluatedMs - Date.parse(snapshot.timestamp);
  if (age < 0) return "unknown";
  return age <= snapshot.stale_after_ms ? "current" : "stale";
}

export function snapshotCounterDelta(
  previous: FleetOperationalSnapshot,
  current: FleetOperationalSnapshot,
  counter: string,
): { state: "continuous" | "restart" | "reset" | "unavailable"; value: number | null } {
  const hasBefore = Object.hasOwn(previous.counters, counter);
  const hasAfter = Object.hasOwn(current.counters, counter);
  if (!hasBefore && !hasAfter) {
    throw new Error(`snapshot counter ${counter} is not present in either snapshot`);
  }
  const before = hasBefore ? previous.counters[counter] : undefined;
  const after = hasAfter ? current.counters[counter] : undefined;
  if (before === null || before === undefined || after === null || after === undefined) {
    return { state: "unavailable", value: null };
  }
  if (previous.process_id === null || current.process_id === null) {
    return { state: "unavailable", value: null };
  }
  if (previous.process_id !== current.process_id) {
    return { state: "restart", value: null };
  }
  if (after < before) return { state: "reset", value: null };
  return { state: "continuous", value: after - before };
}

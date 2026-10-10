import { createHash } from "crypto";

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
    throw new FleetValueError(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name);
}

function timestampValue(value: unknown, name: string): string {
  const timestamp = stringValue(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) {
    throw new FleetValueError(`${name} must be an RFC 3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(timestamp);
  const canonical = timestamp.includes(".") ? timestamp : timestamp.replace("Z", ".000Z");
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw new FleetValueError(`${name} must be a valid timestamp`);
  }
  return timestamp;
}

export function canonicalFleetTimestamp(value: unknown, name: string): string {
  return timestampValue(value, name);
}

function nullableMeasurement(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new FleetValueError(`${name} must be a non-negative number or null`);
  }
  return value;
}

function nullableInteger(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FleetValueError(`${name} must be a non-negative integer or null`);
  }
  return value;
}

const URL_USERINFO = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i;
const BARE_USERINFO = /^[^/?#:@]+:[^/?#@]*@/;
const CREDENTIAL_PARAM_SEGMENTS = new Set([
  "accesstoken",
  "accesstokens",
  "apikey",
  "apikeys",
  "apitoken",
  "apitokens",
  "auth",
  "authorization",
  "authtoken",
  "authtokens",
  "bearer",
  "clientsecret",
  "clientsecrets",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "hmac",
  "idtoken",
  "idtokens",
  "jsessionid",
  "jwt",
  "key",
  "keys",
  "pass",
  "passphrase",
  "passphrases",
  "passwd",
  "passwds",
  "password",
  "passwords",
  "privkey",
  "privkeys",
  "pwd",
  "pwds",
  "refreshtoken",
  "refreshtokens",
  "secret",
  "secrets",
  "secretkey",
  "secretkeys",
  "sessiontoken",
  "sessiontokens",
  "sig",
  "sigs",
  "signature",
  "signatures",
  "token",
]);
// Unseparated compounds (apitoken, apikeys, privatekeypem) have no segment
// boundary to split on, so a denylist of whole segments alone fails open on them.
// No telemetry name contains these stems, so they match anywhere in a segment.
const CREDENTIAL_PARAM_STEMS = [
  "accesskey",
  "apikey",
  "apitoken",
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
const CREDENTIAL_PARAM_SUFFIXES = ["secret", "secrets", "signature", "signatures", "token"];

// A token segment followed by one of these names a count or class, not a
// credential (tokenCount, token_type, token_max) — core telemetry for a token-accounting tool.
const TOKEN_TELEMETRY_QUALIFIERS = new Set([
  "avg", "budget", "count", "counts", "kind", "limit", "max", "min", "rate", "sum", "total", "type", "usage",
]);

function isCredentialSegment(segment: string, next: string | undefined): boolean {
  if (segment === "token" && next !== undefined && TOKEN_TELEMETRY_QUALIFIERS.has(next)) return false;
  return CREDENTIAL_PARAM_SEGMENTS.has(segment) ||
    CREDENTIAL_PARAM_STEMS.some((stem) => segment.includes(stem)) ||
    CREDENTIAL_PARAM_SUFFIXES.some((suffix) => segment.endsWith(suffix));
}

function hasCredentialSegment(name: string): boolean {
  const normNoDelim = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (CREDENTIAL_PARAM_STEMS.some((stem) => normNoDelim.includes(stem))) return true;
  const segments = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((segment) => segment.replace(/(?<!\d)\d+$/, ""));
  return segments.some((segment, index) =>
    !isNonCredentialKeyName(segment, segments[index - 1]) && isCredentialSegment(segment, segments[index + 1]));
}

function isNonCredentialKeyName(segment: string, previous: string | undefined): boolean {
  return (segment === "key" || segment === "keys") && previous !== undefined && NON_CREDENTIAL_KEY_PREFIXES.includes(previous);
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

/** An input value outside the contract, as opposed to a malformed record shape. */
export class FleetValueError extends Error {}

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
  String.raw`\b(?:bearer|basic)[\s+]+\S`,
  String.raw`\beyJ[\w-]{8,}\.[\w-]{8,}`,
  String.raw`(?:^|[^a-z0-9])sk-[\w-]{16,}`,
  String.raw`\b(?:sk|rk|pk)_(?:live|test)_\w{8,}`,
  String.raw`\bgh[pousr]_\w{20,}`,
  String.raw`\bgithub_pat_\w{20,}`,
  String.raw`\bglpat-[\w-]{12,}`,
  String.raw`\b(?:xox[abposr]|xapp)-[\w-]{10,}`,
  String.raw`\bAIza[0-9A-Za-z_-]{20,}`,
  String.raw`\bnpm_[0-9A-Za-z]{20,}`,
].join("|"), "i");
// AWS key IDs are uppercase; under the shared /i flag "asiapacific..." would match.
const AWS_ACCESS_KEY_ID = /\bA[SK]IA[0-9A-Z]{16}\b/;

function hasBareCredential(text: string): boolean {
  return BARE_CREDENTIAL.test(text) || AWS_ACCESS_KEY_ID.test(text);
}

const CREDENTIAL_PARAM_KEYS = new Set([
  "accesskey",
  "accesskeys",
  "accesstoken",
  "accesstokens",
  "apikey",
  "apikeys",
  "apitoken",
  "apitokens",
  "authkey",
  "authkeys",
  "authorization",
  "authtoken",
  "authtokens",
  "bearer",
  "clientsecret",
  "clientsecrets",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "hmac",
  "idtoken",
  "idtokens",
  "jsessionid",
  "jwt",
  "passphrase",
  "passphrases",
  "passwd",
  "passwds",
  "password",
  "passwords",
  "privkey",
  "privkeys",
  "privatekey",
  "privatekeys",
  "pwd",
  "pwds",
  "refreshtoken",
  "refreshtokens",
  "secret",
  "secrets",
  "secretkey",
  "secretkeys",
  "sessiontoken",
  "sessiontokens",
  "sig",
  "sigs",
  "signature",
  "signatures",
]);

// Token counts and limits are named like credentials (input_tokens, max_tokens).
const TELEMETRY_TOKEN_PREFIXES = [
  "input", "output", "prompt", "completion", "reasoning", "cache", "cumulative", "max", "total",
];
// Database and map key names, not credentials (sort_key, partition_key, public_key).
// primary and routing are left out: an Azure primary key is the access key,
// and a PagerDuty routing_key is the integration secret.
const NON_CREDENTIAL_KEY_PREFIXES = ["sort", "cache", "public", "partition", "foreign"];
const COMPOUND_KEY_PREFIX =
  /(?:api|access|auth|secret|priv|private|client|app|signing|encryption|master|ssh|deploy|session|consumer|service|account|license|shared)keys?$/;

function isTelemetryValue(text: string): boolean {
  const parts = text.split(/[\s:=]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 && parts.every((part) => TOKEN_TELEMETRY_QUALIFIERS.has(part) || /^\d+(?:\.\d+)?$/.test(part));
}

function isTokenName(norm: string): boolean {
  return norm.endsWith("token") || norm.endsWith("tokens");
}

// max_access_token is a credential behind a telemetry prefix, not a count.
const CREDENTIAL_TOKEN_SUFFIX = /(?:access|api|auth|session|refresh|id|bot|bearer)tokens?$/;

function isTelemetryTokenName(norm: string): boolean {
  return TELEMETRY_TOKEN_PREFIXES.some((prefix) => norm.startsWith(prefix)) && !CREDENTIAL_TOKEN_SUFFIX.test(norm);
}

// keyRaw keeps its case so adminKey splits into admin_key; norm is lowercased with - and _ removed.
function isCompoundCredentialKey(keyRaw: string, norm: string): boolean {
  if (/(?:secret|secrets|password|passwords|passwd|passwds|sig|sigs|signature|signatures)$/.test(norm)) return true;
  if (!(norm.endsWith("key") || norm.endsWith("keys"))) return false;
  const compound =
    /(?:^|[^a-z0-9])[a-z0-9]+[-_]keys?$/i.test(keyRaw.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    || COMPOUND_KEY_PREFIX.test(norm);
  return compound && !NON_CREDENTIAL_KEY_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

function isCredentialPair(keyRaw: string, valRaw: string): boolean {
  const key = keyRaw.toLowerCase().replace(/[-_]/g, "");
  const val = valRaw.toLowerCase().replace(/^["\x27\[\s]+|["\x27\]\s]+$/g, "").trim();

  if (CREDENTIAL_PARAM_KEYS.has(key)) return true;
  if (isTokenName(key)) {
    if (val === "" || val === "null" || val === "[]" || isTelemetryValue(val)) return false;
    return !isTelemetryTokenName(key);
  }
  // Bare "key" (tag={"key": "env"}) and words that merely end in key (monkey) are not credentials.
  return isCompoundCredentialKey(keyRaw, key);
}

// A name:value chain (host:token:..., token:total:secret) carries a credential
// when a token name is followed by anything other than telemetry, or when any
// adjacent pair is a credential name and its value.
function hasCredentialColonChain(parts: string[]): boolean {
  for (let j = 0; j < parts.length; j++) {
    const partNorm = parts[j]?.toLowerCase().replace(/[-_]/g, "") ?? "";
    if (partNorm === "token" || partNorm === "tokens") {
      for (let k = j + 1; k < parts.length; k++) {
        if (!isTelemetryValue(parts[k]?.toLowerCase().trim() ?? "")) return true;
      }
    }
    if (j < parts.length - 1 && isCredentialPair(parts[j] ?? "", parts[j + 1] ?? "")) return true;
  }
  return false;
}

// A path segment naming a credential class is a positional credential when
// another segment follows it to carry the value. token/tokens followed by a
// telemetry qualifier (/tokens/total) is exempt, as are telemetry token names
// and compound words under a filesystem root. "auth" is left out on purpose:
// it names a mechanism, and an adapter base URL can end in /auth.
const CREDENTIAL_PATH_WORDS = new Set([...CREDENTIAL_PARAM_KEYS, "token", "tokens"]);

function isCredentialPathWord(segment: string, norm: string): boolean {
  if (CREDENTIAL_PATH_WORDS.has(norm)) return true;
  if (isTokenName(norm)) return !isTelemetryTokenName(norm);
  return isCompoundCredentialKey(segment, norm);
}

// A Slack-style webhook path (/services/T000/B000/<token>) is fully specified
// by its last segment, so the whole path is one positional credential.
const SLACK_WEBHOOK_PATH = /(?:^|\/)services(?:;[^/]*)?\/T[0-9A-Z]+(?:;[^/]*)?\/B[0-9A-Z]+(?:;[^/]*)?\/[^/?#\s]+/i;

// After token/<qualifier>, the rest of a telemetry path is words, counts,
// durations, and dates (/tokens/usage/daily, /token/count/5m); anything else
// may be the value the path was built to carry.
const TELEMETRY_PATH_TAIL = /^(?:[a-z]{1,16}|\d+(?:\.\d+)?|\d+[smhdw]|\d{4}-\d{2}(?:-\d{2})?)$/;

const PLURAL_CREDENTIAL_WORD = /(?:tokens|keys|secrets|passwords|passwds|signatures|sigs|credentials|cookies)$/;
// A bare /path can be a host-less URL path (/api/v1/github_token/...), so only
// paths under a filesystem root count, plus ~/, a drive letter, and file:.
const ABSOLUTE_FILE_PATH = /^(?:\/(?:Users|home|root|tmp|var|opt|srv|mnt|private|Volumes|Library|usr|nix|workspaces?|github|builds)\/|~\/|[a-z]:\/(?!\/)|file:)/i;

function hasPositionalCredential(decoded: string): boolean {
  const normalized = decoded.replaceAll("\\", "/");
  const [pathPart = ""] = normalized.split(/[?#]/, 1);
  const pathMatch = pathPart.match(/^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#]+)?([^?#]*)/i);
  const pathname = pathMatch ? (pathMatch[1] ?? "") : pathPart;
  if (SLACK_WEBHOOK_PATH.test(pathname)) return true;
  // Under a filesystem root, a plural credential word names a collection
  // directory (design-tokens, my-secrets, signing-keys), not a slot for one
  // value; a singular one (db_password, my_api_key) still counts.
  const fileLocator = ABSOLUTE_FILE_PATH.test(normalized.trim());

  const rawSegments = pathname.split("/").filter((s) => s.length > 0);
  for (let i = 0; i < rawSegments.length; i++) {
    const rawSegment = rawSegments[i];
    if (!rawSegment) continue;
    const segment = rawSegment.split(";")[0]?.trim() ?? "";
    if (!segment) continue;

    const colonParts = segment.split(/\s*:\s*/);
    if (colonParts.length > 1 && hasCredentialColonChain(colonParts)) return true;

    const norm = segment.toLowerCase().replace(/[-_]/g, "");
    const collectionDir = fileLocator && PLURAL_CREDENTIAL_WORD.test(norm)
      && !CREDENTIAL_PARAM_STEMS.some((stem) => norm.includes(stem)) && !CREDENTIAL_TOKEN_SUFFIX.test(norm);
    if (isCredentialPathWord(segment, norm) && !collectionDir) {
      if (i + 1 < rawSegments.length) {
        const nextRaw = rawSegments[i + 1];
        const nextSegment = (nextRaw ? nextRaw.split(";")[0]?.trim().toLowerCase() : "") ?? "";
        if (norm === "token" || norm === "tokens") {
          if (TOKEN_TELEMETRY_QUALIFIERS.has(nextSegment)) {
            const tail = rawSegments.slice(i + 2).map((raw) => raw.split(";")[0]?.trim() ?? "");
            if (tail.some((seg) => seg !== "" && !TELEMETRY_PATH_TAIL.test(seg))) return true;
            continue;
          }
        }
        return true;
      }
    }
  }
  return false;
}

function hasCredentialValue(decoded: string): boolean {
  if (hasBareCredential(decoded)) return true;
  if (SLACK_WEBHOOK_PATH.test(decoded.replaceAll("\\", "/"))) return true;

  const checkPair = (key: string, val: string): boolean => {
    if (isCredentialPair(key, val)) return true;
    return val.includes(":") && hasCredentialColonChain(val.split(/\s*:\s*/));
  };

  const checkTextValues = (text: string): boolean => {
    const unescaped = text.replace(/\\(["\x27\\])/g, "$1");
    const pattern = /["\x27]?([a-z0-9_-]+)["\x27]?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,}"\x27&]+))/gi;
    for (const match of unescaped.matchAll(pattern)) {
      const key = match[1];
      const val = match[2] ?? match[3] ?? match[4];
      if (key && val && checkPair(key, val)) return true;
    }

    if (unescaped.includes("[")) {
      const arrayPattern = /["\x27]?([a-z0-9_-]+)["\x27]?\s*[:=]\s*\[([^\]]*)\]/gi;
      for (const match of unescaped.matchAll(arrayPattern)) {
        const key = match[1];
        const rawList = match[2];
        if (key && rawList) {
          const items = rawList
            .split(",")
            .map((s) => s.replace(/^["\x27\s]+|["\x27\s]+$/g, "").trim())
            .filter((s) => s.length > 0);
          for (const item of items) {
            if (checkPair(key, item)) return true;
          }
        }
      }
    }
    return false;
  };

  if (checkTextValues(decoded)) return true;

  // The whole-locator pass reads "https" as a key and the rest of the URL as its
  // value, so a header-style value (h=Authorization:...) is only seen per parameter.
  const params = decoded.split(/[&;?#]/);
  for (const param of params) {
    const eqIdx = param.indexOf("=");
    if (eqIdx === -1) continue;
    const paramKey = param.slice(0, eqIdx);
    const paramVal = param.slice(eqIdx + 1);
    if (checkPair(paramKey, paramVal)) return true;
    if (checkTextValues(paramVal)) return true;
  }
  return false;
}

export function assertSafeLabelValue(value: string): void {
  if (value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  const decoded = decodeLocator(value);
  if (
    decoded === null
    || hasUserinfo(decoded)
    || EMBEDDED_USERINFO.test(decoded)
    || hasBareCredential(decoded)
    || locatorParams(decoded).some(isCredentialParam)
    || [...decoded.matchAll(SPACED_ASSIGNMENT)]
      .some((match) => isCredentialParam(match[1]!))
  ) {
    throw new PrivacyError("credential-like label value rejected");
  }
}

interface SanitizedValue<T> {
  value: T;
  redacted: boolean;
}

function privateSafeNullableString(value: unknown, name: string): SanitizedValue<string | null> {
  const label = nullableString(value, name);
  if (label === null) return { value: null, redacted: false };
  try {
    assertSafeLabelValue(label);
    return { value: label, redacted: false };
  } catch (error) {
    if (error instanceof PrivacyError) return { value: null, redacted: true };
    throw error;
  }
}

function privateSafeRequiredString(value: unknown, name: string): SanitizedValue<string> {
  const label = stringValue(value, name);
  try {
    assertSafeLabelValue(label);
    return { value: label, redacted: false };
  } catch (error) {
    if (error instanceof PrivacyError) return { value: "unknown", redacted: true };
    throw error;
  }
}

function privateSafeRecordId(value: unknown): string {
  const recordId = stringValue(value, "record_id");
  try {
    assertSafeLabelValue(recordId);
    return recordId;
  } catch (error) {
    if (error instanceof PrivacyError) {
      const digest = createHash("sha256")
        .update(JSON.stringify([["string", recordId]]))
        .digest("hex");
      return `record:opaque:${digest}`;
    }
    throw error;
  }
}

function qualifiedId(value: unknown, name: string): SanitizedValue<string | null> {
  const id = nullableString(value, name);
  if (id === null) return { value: null, redacted: false };
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`${name} must be source-qualified`);
  }
  try {
    assertSafeLabelValue(id);
    return { value: id, redacted: false };
  } catch (error) {
    if (error instanceof PrivacyError) return { value: null, redacted: true };
    throw error;
  }
}

function locatorValue(value: unknown): string | null {
  const locator = nullableString(value, "provenance.locator");
  if (locator === null) return null;
  if (hasUserinfo(locator)) {
    throw new PrivacyError("provenance.locator cannot contain URL credentials");
  }
  const decoded = decodeLocator(locator);
  if (decoded !== null && EMBEDDED_USERINFO.test(decoded.replaceAll("\\", "/"))) {
    throw new PrivacyError("provenance.locator cannot contain URL credentials");
  }
  if (decoded === null || locatorParams(decoded).some(isCredentialParam)) {
    throw new PrivacyError("provenance.locator cannot contain credential query parameters");
  }
  if (hasPositionalCredential(decoded)) {
    throw new PrivacyError("provenance.locator cannot contain a positional credential segment");
  }
  if (hasCredentialValue(decoded)) {
    throw new PrivacyError("provenance.locator cannot carry a credential value");
  }
  return locator;
}

export function privateSafeLocator(value: string | null): SanitizedValue<string | null> {
  try {
    return { value: locatorValue(value), redacted: false };
  } catch (error) {
    if (error instanceof PrivacyError) return { value: null, redacted: true };
    throw error;
  }
}

function provenanceValue(value: unknown): SanitizedValue<FleetProvenance> {
  const provenance = objectValue(value, "provenance");
  assertExactKeys(provenance, ["source", "locator", "collected_at", "completeness"], "provenance");
  const completeness = provenance.completeness;
  if (completeness !== "complete" && completeness !== "partial" && completeness !== "unavailable") {
    throw new Error("provenance.completeness is invalid");
  }
  const source = privateSafeRequiredString(provenance.source, "provenance.source");
  const locator = locatorValue(provenance.locator);
  return {
    value: {
      source: source.value,
      locator,
      collected_at: timestampValue(provenance.collected_at, "provenance.collected_at"),
      completeness,
    },
    redacted: source.redacted,
  };
}

function commonFields(
  record: Record<string, unknown>,
  redactedStatus: "incomplete" | "partial",
): FleetRecordFields {
  if (record.schema_version !== FLEET_SCHEMA_VERSION) {
    throw new Error(`unsupported fleet schema version ${String(record.schema_version)}`);
  }
  if (!RECORD_STATUSES.has(record.status as FleetRecordStatus)) {
    throw new Error("status is invalid");
  }
  const runId = qualifiedId(record.run_id, "run_id");
  const sessionId = qualifiedId(record.session_id, "session_id");
  const requestId = qualifiedId(record.request_id, "request_id");
  const promptOriginHost = privateSafeNullableString(record.prompt_origin_host, "prompt_origin_host");
  const executionHost = privateSafeNullableString(record.execution_host, "execution_host");
  const routerHost = privateSafeNullableString(record.router_host, "router_host");
  const backendHost = privateSafeNullableString(record.backend_host, "backend_host");
  const harness = privateSafeNullableString(record.harness, "harness");
  const provider = privateSafeNullableString(record.provider, "provider");
  const backend = privateSafeNullableString(record.backend, "backend");
  const model = privateSafeNullableString(record.model, "model");
  const provenance = provenanceValue(record.provenance);
  const redacted = [
    runId,
    sessionId,
    requestId,
    promptOriginHost,
    executionHost,
    routerHost,
    backendHost,
    harness,
    provider,
    backend,
    model,
    provenance,
  ].some((field) => field.redacted);
  const status = record.status as FleetRecordStatus;
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    record_id: privateSafeRecordId(record.record_id),
    run_id: runId.value,
    session_id: sessionId.value,
    request_id: requestId.value,
    prompt_origin_host: promptOriginHost.value,
    execution_host: executionHost.value,
    router_host: routerHost.value,
    backend_host: backendHost.value,
    harness: harness.value,
    provider: provider.value,
    backend: backend.value,
    model: model.value,
    status: redacted && status === "ok" ? redactedStatus : status,
    provenance: redacted && provenance.value.completeness === "complete"
      ? { ...provenance.value, completeness: "partial" }
      : provenance.value,
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
      ...commonFields(record, "incomplete"),
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
    let countersRedacted = false;
    for (const [name, counter] of Object.entries(counters).sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (!name) throw new Error("counter names cannot be empty");
      try {
        assertSafeLabelValue(name);
        parsedCounters[name] = nullableMeasurement(counter, `counters.${name}`);
      } catch (error) {
        if (!(error instanceof PrivacyError)) throw error;
        countersRedacted = true;
      }
    }
    const processId = qualifiedId(record.process_id, "process_id");
    let common = commonFields(record, "partial");
    if ((processId.redacted || countersRedacted) && common.provenance.completeness === "complete") {
      common = {
        ...common,
        status: common.status === "ok" ? "partial" : common.status,
        provenance: { ...common.provenance, completeness: "partial" },
      };
    }
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
      process_id: processId.value,
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

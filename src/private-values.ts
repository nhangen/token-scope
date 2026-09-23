import { createHash } from "crypto";

export class PrivacyError extends Error {}

function safeLabel(value: string): string {
  return value;
}

export function assertSafeLabelValue(value: string): void {
  if (value.length > 256) {
    throw new PrivacyError("overlength label value rejected");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new PrivacyError("control-bearing label value rejected");
  }
  if (/\b(?:bearer|basic)(?:\s+|%20)\S+/i.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  if (/(?:^|[^a-z0-9])(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|glpat-[a-z0-9_-]+|sk-[a-z0-9_-]+)(?=$|[^a-z0-9_-])/i.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  if (/(?:^|[^a-z0-9_-])(?:AIza[a-z0-9_-]{20,}|(?:xox[bpa]|xapp)-[a-z0-9-]{10,}|npm_[a-z0-9]{20,})(?=$|[^a-z0-9_-])/i.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  if (/(?:^|[^a-z0-9_-])eyJ[a-z0-9_-]*\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?=$|[^a-z0-9_-])/i.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  if (/(?:^|[?&#/:;\s])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret|token|key)\s*[:=]\s*\S+/i.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  try {
    const parsed = new URL(value);
    const sensitiveQuery = [...parsed.searchParams.keys()].some((key) =>
      /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret|token|key)$/i.test(key)
    );
    if (parsed.username !== "" || parsed.password !== "" || sensitiveQuery) {
      throw new PrivacyError("credential-like label value rejected");
    }
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
  }
}

export function privateSafeLabel(value: string): string {
  assertSafeLabelValue(value);
  return safeLabel(value);
}

export function privateOpaqueId(
  namespace: string,
  ...parts: Array<string | number | null | undefined>
): string {
  const safeNamespace = privateSafeLabel(namespace);
  const completeParts = parts.map((part) => {
    if (part === null) return ["null"];
    if (part === undefined) return ["undefined"];
    if (typeof part === "string") return ["string", part];
    if (Number.isNaN(part)) return ["number", "NaN"];
    if (Object.is(part, -0)) return ["number", "-0"];
    return ["number", String(part)];
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(completeParts))
    .digest("hex");
  return `${safeNamespace}:opaque:${digest}`;
}

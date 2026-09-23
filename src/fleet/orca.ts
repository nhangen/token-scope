import {
  FLEET_SCHEMA_VERSION,
  parseFleetRecord,
  type FleetOperationalSnapshot,
  type FleetProvenance,
} from "@/fleet-contract";

const APPROVED_ORCA_COMMANDS = Object.freeze([
  Object.freeze(["status", "--json"] as const),
  Object.freeze(["host", "list", "--json"] as const),
  Object.freeze(["worktree", "ps", "--json"] as const),
  Object.freeze(["terminal", "list", "--json"] as const),
] as const);
const ORCA_EXECUTABLE = "orca";
const ORCA_AGENT_IDENTITIES = Object.freeze([
  "claude",
  "claude-agent-teams",
  "openclaude",
  "codex",
  "autohand",
  "opencode",
  "opencode2",
  "mimo-code",
  "pi",
  "omp",
  "gemini",
  "antigravity",
  "aider",
  "goose",
  "amp",
  "kilo",
  "kiro",
  "crush",
  "aug",
  "cline",
  "codebuff",
  "freebuff",
  "command-code",
  "continue",
  "cursor",
  "droid",
  "kimi",
  "mistral-vibe",
  "qwen-code",
  "rovo",
  "hermes",
  "openclaw",
  "copilot",
  "grok",
  "devin",
  "ante",
  "trae",
  "muse",
  "prime-agent",
] as const);

export const ORCA_READ_ONLY_COMMANDS = APPROVED_ORCA_COMMANDS;

export interface OrcaCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type OrcaCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<OrcaCommandResult>;

export type OrcaSourceReason =
  | "missing_cli"
  | "runtime_unavailable"
  | "unsupported_version"
  | "command_failed"
  | "malformed"
  | "partial_records"
  | "privacy"
  | null;

export interface OrcaSourceObservation {
  command: string;
  state: "available" | "partial" | "unavailable";
  reason: OrcaSourceReason;
  provenance: FleetProvenance;
}

export interface OrcaHostIdentity {
  stableId: string;
  sourceId: string;
  kind: "local" | "ssh" | "runtime";
  name: string | null;
  platform: string | null;
  connected: boolean | null;
}

export interface OrcaPlacementMetadata {
  terminalHandle: string;
  worktreeId: string | null;
  agentType: string | null;
  placement: "local" | "ssh" | "runtime" | "unknown";
  observedAt: string;
}

export interface OrcaPlacementCollection {
  records: FleetOperationalSnapshot[];
  metadata: Record<string, OrcaPlacementMetadata>;
  hosts: Record<string, OrcaHostIdentity>;
  sources: OrcaSourceObservation[];
  runtime: {
    id: string | null;
    version: string | null;
  };
}

export interface CollectOrcaPlacementOptions {
  collectedAt?: string;
  executable?: string;
  runner?: OrcaCommandRunner;
}

interface LoadedCommand {
  value: Record<string, unknown> | null;
  observation: OrcaSourceObservation;
}

interface WorktreePlacement {
  hostId: string;
  agents: Map<string, string>;
  ambiguousPaneKeys: Set<string>;
}

interface WorktreeIndexEntry {
  placement: WorktreePlacement;
  ambiguous: boolean;
}

interface ParsedWorktrees {
  index: Map<string, WorktreeIndexEntry>;
  partial: boolean;
}

interface OrcaHostScope {
  hostIds: Set<string>;
  omittedHostIds: Set<string>;
}

class PrivacyError extends Error {}

const SENSITIVE_KEY = /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret|token|key)$/i;
const CREDENTIAL_VALUE = /\b(?:bearer|basic)(?:\s+|%20)\S+|(?:^|[?&#/:;\s])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret|token|key)\s*[:=]\s*\S+/i;
const RAW_CREDENTIAL_VALUE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/i;

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeString(value: unknown, name: string): string {
  const raw = optionalString(value);
  if (raw === null) throw new Error(`${name} must be a non-empty string`);
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  if (text.length === 0) throw new Error(`${name} must be a non-empty string`);
  if (CREDENTIAL_VALUE.test(text) || RAW_CREDENTIAL_VALUE.test(text)) {
    throw new PrivacyError(`${name} contains a credential-like value`);
  }
  try {
    const parsed = new URL(text);
    const sensitiveQuery = [...parsed.searchParams.keys()].some((key) => SENSITIVE_KEY.test(key));
    if (parsed.username !== "" || parsed.password !== "" || sensitiveQuery) {
      throw new PrivacyError(`${name} contains a credential-like URL`);
    }
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
  }
  return text.slice(0, 2048);
}

function optionalSafeString(value: unknown, name: string): string | null {
  return optionalString(value) === null ? null : safeString(value, name);
}

function orcaAgentIdentity(value: unknown, name: string): { value: string | null; invalid: boolean } {
  const candidate = optionalSafeString(value, name);
  if (candidate === null) return { value: null, invalid: false };
  if (!(ORCA_AGENT_IDENTITIES as readonly string[]).includes(candidate)) {
    return { value: null, invalid: true };
  }
  return { value: candidate, invalid: false };
}

function canonicalTimestamp(value: unknown, name: string): string {
  const raw = safeString(value, name);
  const milliseconds = Date.parse(raw);
  if (Number.isNaN(milliseconds)) throw new Error(`${name} must be a timestamp`);
  return new Date(milliseconds).toISOString();
}

function commandLabel(args: readonly string[]): string {
  return `orca ${args.join(" ")}`;
}

function provenance(
  args: readonly string[],
  collectedAt: string,
  completeness: FleetProvenance["completeness"],
): FleetProvenance {
  return {
    source: commandLabel(args),
    locator: null,
    collected_at: collectedAt,
    completeness,
  };
}

function observation(
  args: readonly string[],
  collectedAt: string,
  state: OrcaSourceObservation["state"] = "available",
  reason: OrcaSourceReason = null,
): OrcaSourceObservation {
  return {
    command: commandLabel(args),
    state,
    reason,
    provenance: provenance(
      args,
      collectedAt,
      state === "available" ? "complete" : state === "partial" ? "partial" : "unavailable",
    ),
  };
}

function parseJsonResult(output: string, name: string): Record<string, unknown> {
  const envelope = objectValue(JSON.parse(output), name);
  if (envelope.ok !== true) throw new Error(`${name} failed`);
  return objectValue(envelope.result, `${name}.result`);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

async function defaultRunner(executable: string, args: readonly string[]): Promise<OrcaCommandResult> {
  const child = Bun.spawn([executable, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function loadCommand(
  runner: OrcaCommandRunner,
  executable: string,
  args: readonly string[],
  collectedAt: string,
): Promise<LoadedCommand> {
  try {
    const result = await runner(executable, args);
    if (result.exitCode !== 0) {
      return { value: null, observation: observation(args, collectedAt, "unavailable", "command_failed") };
    }
    try {
      return {
        value: parseJsonResult(result.stdout, commandLabel(args)),
        observation: observation(args, collectedAt),
      };
    } catch {
      return { value: null, observation: observation(args, collectedAt, "partial", "malformed") };
    }
  } catch (error) {
    const reason = errorCode(error) === "ENOENT" ? "missing_cli" : "command_failed";
    return { value: null, observation: observation(args, collectedAt, "unavailable", reason) };
  }
}

function supportedVersion(version: string): boolean {
  return /^1\.\d+\.\d+(?:[-+].*)?$/.test(version);
}

function sourceHostId(kind: OrcaHostIdentity["kind"], id: string): string {
  if (kind === "local") return "local";
  return `${kind}:${encodeURIComponent(id)}`;
}

function stableHostId(sourceId: string): string | null {
  if (sourceId === "local") return "orca:local";
  const match = /^(ssh|runtime):(.+)$/.exec(sourceId);
  if (match === null) return null;
  const encoded = match[2]!;
  if (encoded.includes("|")) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded.length === 0 || encodeURIComponent(decoded) !== encoded) return null;
  } catch {
    return null;
  }
  return `orca:${sourceId}`;
}

function placementKind(sourceId: string | null): OrcaPlacementMetadata["placement"] {
  if (sourceId === "local") return "local";
  if (sourceId?.startsWith("ssh:")) return "ssh";
  if (sourceId?.startsWith("runtime:")) return "runtime";
  return "unknown";
}

function qualify(namespace: string, value: string): string {
  return `${namespace}:${safeString(value, namespace)}`;
}

function parseHosts(value: Record<string, unknown>): Record<string, OrcaHostIdentity> {
  if (!Array.isArray(value.hosts)) throw new Error("hosts must be an array");
  const hosts: Record<string, OrcaHostIdentity> = {};
  for (const candidate of value.hosts) {
    const host = objectValue(candidate, "host");
    const rawKind = safeString(host.kind, "host.kind");
    const kind = rawKind === "environment" ? "runtime" : rawKind;
    if (kind !== "local" && kind !== "ssh" && kind !== "runtime") continue;
    const id = safeString(host.id, "host.id");
    if (kind === "local" && id !== "local") throw new Error("local host.id must be local");
    const sourceId = sourceHostId(kind, id);
    const stableId = stableHostId(sourceId);
    if (stableId === null) throw new Error("host.id is invalid");
    hosts[stableId] = {
      stableId,
      sourceId,
      kind,
      name: optionalSafeString(host.name, "host.name"),
      platform: optionalSafeString(host.platform, "host.platform"),
      connected: typeof host.connected === "boolean" ? host.connected : null,
    };
  }
  return hosts;
}

function worktreeKey(hostId: string, worktreeId: string): string {
  return JSON.stringify([hostId, worktreeId]);
}

function parseWorktrees(value: Record<string, unknown>): ParsedWorktrees {
  if (!Array.isArray(value.worktrees)) throw new Error("worktrees must be an array");
  const index = new Map<string, WorktreeIndexEntry>();
  const scopedHostIds = hostScopeIds(value);
  let partial = false;
  for (const candidate of value.worktrees) {
    const worktree = objectValue(candidate, "worktree");
    const worktreeId = safeString(worktree.worktreeId, "worktree.worktreeId");
    const hostId = optionalSafeString(worktree.hostId, "worktree.hostId");
    if (hostId === null || stableHostId(hostId) === null || scopedHostIds?.has(hostId) !== true) {
      partial = true;
      continue;
    }
    const agents = new Map<string, string>();
    const ambiguousPaneKeys = new Set<string>();
    if (Array.isArray(worktree.agents)) {
      for (const candidateAgent of worktree.agents) {
        const agent = objectValue(candidateAgent, "worktree.agent");
        const paneKey = optionalSafeString(agent.paneKey, "agent.paneKey");
        const parsedAgentType = orcaAgentIdentity(agent.agentType, "agent.agentType");
        if (parsedAgentType.invalid) partial = true;
        if (paneKey !== null && parsedAgentType.value !== null) {
          if (agents.has(paneKey) || ambiguousPaneKeys.has(paneKey)) {
            agents.delete(paneKey);
            ambiguousPaneKeys.add(paneKey);
            partial = true;
          } else {
            agents.set(paneKey, parsedAgentType.value);
          }
        }
      }
    }
    const key = worktreeKey(hostId, worktreeId);
    const existing = index.get(key);
    if (existing !== undefined) {
      existing.ambiguous = true;
      partial = true;
      continue;
    }
    index.set(key, { placement: { hostId, agents, ambiguousPaneKeys }, ambiguous: false });
  }
  return { index, partial };
}

function hostScope(value: Record<string, unknown>): OrcaHostScope | null {
  const scope = value.hostScope;
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return null;
  const hostIds = (scope as Record<string, unknown>).hostIds;
  const omittedHostIds = (scope as Record<string, unknown>).omittedHostIds;
  if (!Array.isArray(hostIds)
    || hostIds.length === 0
    || !hostIds.every((hostId) => typeof hostId === "string" && stableHostId(hostId) !== null)
    || !Array.isArray(omittedHostIds)
    || !omittedHostIds.every((hostId) => typeof hostId === "string" && stableHostId(hostId) !== null)) {
    return null;
  }
  const selected = new Set(hostIds);
  const omitted = new Set(omittedHostIds);
  if (selected.size !== hostIds.length
    || omitted.size !== omittedHostIds.length
    || [...selected].some((hostId) => omitted.has(hostId))) {
    return null;
  }
  return { hostIds: selected, omittedHostIds: omitted };
}

function hostScopeIds(value: Record<string, unknown>): Set<string> | null {
  return hostScope(value)?.hostIds ?? null;
}

function hasCompleteScope(value: Record<string, unknown>): boolean {
  if (value.truncated !== false) return false;
  const rows = Array.isArray(value.terminals)
    ? value.terminals
    : Array.isArray(value.worktrees)
      ? value.worktrees
      : null;
  const scope = hostScope(value);
  return rows !== null
    && Number.isInteger(value.totalCount)
    && value.totalCount === rows.length
    && scope !== null
    && scope.omittedHostIds.size === 0
    && ![...scope.hostIds].some((hostId) => hostId.startsWith("runtime:"));
}

function markPartial(source: OrcaSourceObservation, reason: OrcaSourceReason): void {
  source.state = "partial";
  source.reason = reason;
  source.provenance.completeness = "partial";
}

function addTerminalRecords(
  value: Record<string, unknown>,
  collectedAt: string,
  source: OrcaSourceObservation,
  hosts: Record<string, OrcaHostIdentity>,
  worktrees: Map<string, WorktreeIndexEntry>,
  dependentSourcePartial: boolean,
): { records: FleetOperationalSnapshot[]; metadata: Record<string, OrcaPlacementMetadata> } {
  if (!Array.isArray(value.terminals)) throw new Error("terminals must be an array");
  const records: FleetOperationalSnapshot[] = [];
  const metadata: Record<string, OrcaPlacementMetadata> = {};
  const scopedHostIds = hostScopeIds(value);
  const sourceComplete = hasCompleteScope(value);
  const seenTerminalIdentities = new Map<string, {
    recordIndex: number;
    worktreeId: string;
    paneKey: string | null;
    agentIdentity: string | null;
    invalidAgentIdentity: boolean;
  }>();
  if (!sourceComplete) markPartial(source, "partial_records");
  for (const [terminalIndex, candidate] of value.terminals.entries()) {
    try {
      const terminal = objectValue(candidate, "terminal");
      const handle = safeString(terminal.handle, "terminal.handle");
      const worktreeId = safeString(terminal.worktreeId, "terminal.worktreeId");
      const executionSourceId = optionalSafeString(terminal.executionHostId, "terminal.executionHostId");
      const executionHostCandidate = executionSourceId === null ? null : stableHostId(executionSourceId);
      const executionHostInScope = executionSourceId !== null && scopedHostIds?.has(executionSourceId) === true;
      if (executionHostCandidate === null || !executionHostInScope) {
        markPartial(source, "partial_records");
      }
      const executionHost = executionHostCandidate !== null && hosts[executionHostCandidate] !== undefined
        ? executionHostCandidate
        : null;
      const worktree = executionSourceId === null
        ? undefined
        : worktrees.get(worktreeKey(executionSourceId, worktreeId));
      const paneKey = optionalString(terminal.tabId) !== null && optionalString(terminal.leafId) !== null
        ? `${safeString(terminal.tabId, "terminal.tabId")}:${safeString(terminal.leafId, "terminal.leafId")}`
        : null;
      const paneAmbiguous = paneKey !== null
        && worktree?.placement.ambiguousPaneKeys.has(paneKey) === true;
      const directAgentType = orcaAgentIdentity(terminal.agentIdentity, "terminal.agentIdentity");
      if (directAgentType.invalid) markPartial(source, "partial_records");
      const terminalIdentity = JSON.stringify([executionSourceId, handle]);
      const duplicate = seenTerminalIdentities.get(terminalIdentity);
      if (duplicate !== undefined) {
        markPartial(source, "partial_records");
        if (duplicate.worktreeId !== worktreeId
          || duplicate.paneKey !== paneKey
          || duplicate.agentIdentity !== directAgentType.value
          || duplicate.invalidAgentIdentity !== directAgentType.invalid) {
          const existing = records[duplicate.recordIndex];
          if (existing !== undefined) {
            const unattributed = parseFleetRecord({
              ...existing,
              harness: null,
              status: "partial",
              provenance: { ...existing.provenance, completeness: "partial" },
            });
            if (unattributed.record_type !== "operational_snapshot") {
              throw new Error("wrong fleet record type");
            }
            records[duplicate.recordIndex] = unattributed;
            const existingMetadata = metadata[existing.record_id];
            if (existingMetadata !== undefined) {
              existingMetadata.worktreeId = null;
              existingMetadata.agentType = null;
            }
          }
        }
        continue;
      }
      seenTerminalIdentities.set(terminalIdentity, {
        recordIndex: records.length,
        worktreeId,
        paneKey,
        agentIdentity: directAgentType.value,
        invalidAgentIdentity: directAgentType.invalid,
      });
      const agentType = directAgentType.invalid
        ? null
        : directAgentType.value ?? (paneKey === null || worktree?.ambiguous === true || paneAmbiguous
          ? null
          : worktree?.placement.agents.get(paneKey) ?? null);
      const worktreeQualifiedId = qualify("orca", worktreeId);
      const incomplete = dependentSourcePartial
        || !sourceComplete
        || worktree === undefined
        || worktree.ambiguous
        || paneAmbiguous
        || agentType === null
        || executionHost === null
        || !executionHostInScope;
      const recordProvenance: FleetProvenance = {
        ...source.provenance,
        completeness: incomplete ? "partial" : "complete",
      };
      const start = new Date(Date.parse(collectedAt) - 1).toISOString();
      const record: FleetOperationalSnapshot = {
        schema_version: FLEET_SCHEMA_VERSION,
        record_type: "operational_snapshot",
        record_id: `orca:placement:${encodeURIComponent(collectedAt)}:${terminalIndex}`,
        run_id: null,
        session_id: null,
        request_id: null,
        prompt_origin_host: null,
        execution_host: executionHost,
        router_host: null,
        backend_host: null,
        harness: agentType,
        provider: "orca",
        backend: null,
        model: null,
        timestamp: collectedAt,
        status: incomplete ? "partial" : "ok",
        provenance: recordProvenance,
        window: { start, end: collectedAt },
        process_id: null,
        stale_after_ms: null,
        counters: {},
      };
      const parsed = parseFleetRecord(record);
      if (parsed.record_type !== "operational_snapshot") throw new Error("wrong fleet record type");
      records.push(parsed);
      metadata[parsed.record_id] = {
        terminalHandle: handle,
        worktreeId: worktreeQualifiedId,
        agentType,
        placement: executionHostCandidate === null ? "unknown" : placementKind(executionSourceId),
        observedAt: collectedAt,
      };
    } catch (error) {
      markPartial(source, error instanceof PrivacyError ? "privacy" : "partial_records");
    }
  }
  if (source.state === "partial") {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const parsed = parseFleetRecord({
        ...record,
        status: "partial",
        provenance: { ...record.provenance, completeness: "partial" },
      });
      if (parsed.record_type !== "operational_snapshot") throw new Error("wrong fleet record type");
      records[index] = parsed;
    }
  }
  return { records, metadata };
}

export async function collectOrcaPlacement(
  options: CollectOrcaPlacementOptions = {},
): Promise<OrcaPlacementCollection> {
  const collectedAt = canonicalTimestamp(options.collectedAt ?? new Date().toISOString(), "collectedAt");
  const runner = options.runner ?? defaultRunner;
  const sources: OrcaSourceObservation[] = [];
  const empty = (runtimeId: string | null = null, version: string | null = null): OrcaPlacementCollection => ({
    records: [],
    metadata: {},
    hosts: {},
    sources,
    runtime: { id: runtimeId, version },
  });

  const status = await loadCommand(runner, ORCA_EXECUTABLE, APPROVED_ORCA_COMMANDS[0], collectedAt);
  sources.push(status.observation);
  if (status.value === null) return empty();
  let runtimeId: string | null = null;
  let version: string | null = null;
  try {
    const runtime = objectValue(status.value.runtime, "status.runtime");
    runtimeId = optionalSafeString(runtime.runtimeId, "runtime.runtimeId");
    version = optionalSafeString(runtime.appVersion, "runtime.appVersion");
    if (runtime.reachable !== true || runtime.state !== "ready") {
      status.observation.state = "unavailable";
      status.observation.reason = "runtime_unavailable";
      status.observation.provenance.completeness = "unavailable";
      return empty(runtimeId, version);
    }
    if (version === null || !supportedVersion(version)) {
      status.observation.state = "unavailable";
      status.observation.reason = "unsupported_version";
      status.observation.provenance.completeness = "unavailable";
      return empty(runtimeId, version);
    }
  } catch (error) {
    status.observation.state = "partial";
    status.observation.reason = error instanceof PrivacyError ? "privacy" : "malformed";
    status.observation.provenance.completeness = "partial";
    return empty(runtimeId, version);
  }

  const [hostSource, worktreeSource, terminalSource] = await Promise.all([
    loadCommand(runner, ORCA_EXECUTABLE, APPROVED_ORCA_COMMANDS[1], collectedAt),
    loadCommand(runner, ORCA_EXECUTABLE, APPROVED_ORCA_COMMANDS[2], collectedAt),
    loadCommand(runner, ORCA_EXECUTABLE, APPROVED_ORCA_COMMANDS[3], collectedAt),
  ]);
  sources.push(hostSource.observation, worktreeSource.observation, terminalSource.observation);

  let hosts: Record<string, OrcaHostIdentity> = {};
  if (hostSource.value !== null) {
    try {
      hosts = parseHosts(hostSource.value);
    } catch (error) {
      markPartial(hostSource.observation, error instanceof PrivacyError ? "privacy" : "malformed");
    }
  }

  let worktrees = new Map<string, WorktreeIndexEntry>();
  if (worktreeSource.value !== null) {
    try {
      const parsedWorktrees = parseWorktrees(worktreeSource.value);
      worktrees = parsedWorktrees.index;
      if (parsedWorktrees.partial || !hasCompleteScope(worktreeSource.value)) {
        markPartial(worktreeSource.observation, "partial_records");
      }
    } catch (error) {
      markPartial(worktreeSource.observation, error instanceof PrivacyError ? "privacy" : "malformed");
    }
  }

  if (terminalSource.value === null) return { ...empty(runtimeId, version), hosts };
  try {
    const built = addTerminalRecords(
      terminalSource.value,
      collectedAt,
      terminalSource.observation,
      hosts,
      worktrees,
      hostSource.observation.state !== "available" || worktreeSource.observation.state !== "available",
    );
    return {
      records: built.records.sort((a, b) => a.record_id.localeCompare(b.record_id)),
      metadata: built.metadata,
      hosts,
      sources,
      runtime: { id: runtimeId, version },
    };
  } catch (error) {
    markPartial(terminalSource.observation, error instanceof PrivacyError ? "privacy" : "malformed");
    return { ...empty(runtimeId, version), hosts };
  }
}

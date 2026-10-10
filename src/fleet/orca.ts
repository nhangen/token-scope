import {
  assertSafeLabelValue,
  FLEET_SCHEMA_VERSION,
  objectValue,
  parseFleetRecord,
  PrivacyError,
  type FleetOperationalSnapshot,
  type FleetProvenance,
  type FleetRecord,
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

// A stalled `orca` process (for example a hung SSH host) must not block
// collection indefinitely. The default runner enforces a kill timer and
// reports a timeout as `command_failed`.
export const ORCA_COMMAND_TIMEOUT_MS = 10_000;

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

// Orca worktree IDs are "<repoId>::<absolute path>". Read whole, the shared
// check takes "repo-token:" for a header name, so each half is checked on its
// own. A right half that is not an absolute path gets the whole-value check.
const WORKTREE_ID = /^([^:]+)::((?:\/|[A-Za-z]:[\\/]).*)$/;

function checkWorktreeId(raw: string): void {
  const parts = WORKTREE_ID.exec(raw);
  if (parts === null) {
    assertSafeLabelValue(raw);
    return;
  }
  assertSafeLabelValue(parts[1]!);
  assertSafeLabelValue(parts[2]!);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeString(
  value: unknown,
  name: string,
  check: (raw: string) => void = assertSafeLabelValue,
): string {
  const raw = optionalString(value);
  if (raw === null) throw new Error(`${name} must be a non-empty string`);
  check(raw);
  const text = raw.replace(/[\p{Cc}\p{Cf}]/gu, "");
  if (text.length === 0) throw new Error(`${name} must be a non-empty string`);
  return text.slice(0, 2048);
}

function safeWorktreeId(value: unknown, name: string): string {
  return safeString(value, name, checkWorktreeId);
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

export class OrcaCommandError extends Error {}

// A record-construction regression in the adapter itself. It must propagate
// instead of being reported as a source data fault.
export class OrcaInvariantError extends Error {}

// Every field of an adapter-built snapshot is validated upstream (host ids via
// `stableHostId`, harness via the agent allowlist), so a plain contract
// rejection here means the adapter built a bad record. A PrivacyError still
// reflects source content and stays a typed source fault.
function parseOwnSnapshot(record: unknown): FleetOperationalSnapshot {
  let parsed: FleetRecord;
  try {
    parsed = parseFleetRecord(record);
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    throw new OrcaInvariantError("adapter built a record the fleet contract rejects", { cause: error });
  }
  if (parsed.record_type !== "operational_snapshot") throw new OrcaInvariantError("wrong fleet record type");
  return parsed;
}

function parseJsonResult(output: string, name: string): Record<string, unknown> {
  const envelope = objectValue(JSON.parse(output), name);
  if (envelope.ok === false) throw new OrcaCommandError(`${name} failed`);
  if (envelope.ok !== true) throw new Error(`${name}.ok must be a boolean`);
  return objectValue(envelope.result, `${name}.result`);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export async function defaultRunner(
  executable: string,
  args: readonly string[],
  timeoutMs: number = ORCA_COMMAND_TIMEOUT_MS,
): Promise<OrcaCommandResult> {
  const child = Bun.spawn([executable, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // The process may have already exited; the kill timer is best effort.
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
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
    } catch (error) {
      // An `ok:false` envelope is an Orca-reported command failure with no
      // partial data; only a genuinely unparsable or malformed payload is a
      // data fault.
      if (error instanceof OrcaCommandError) {
        return { value: null, observation: observation(args, collectedAt, "unavailable", "command_failed") };
      }
      if (error instanceof PrivacyError) {
        return { value: null, observation: observation(args, collectedAt, "partial", "privacy") };
      }
      return { value: null, observation: observation(args, collectedAt, "partial", "malformed") };
    }
  } catch (error) {
    const reason = errorCode(error) === "ENOENT" ? "missing_cli" : "command_failed";
    return { value: null, observation: observation(args, collectedAt, "unavailable", reason) };
  }
}

function supportedVersion(version: string): boolean {
  return /^1\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
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

function qualifyWorktree(namespace: string, value: string): string {
  return `${namespace}:${safeWorktreeId(value, namespace)}`;
}

function parseHosts(value: Record<string, unknown>): { hosts: Record<string, OrcaHostIdentity>; partial: boolean } {
  if (!Array.isArray(value.hosts)) throw new Error("hosts must be an array");
  const hosts: Record<string, OrcaHostIdentity> = {};
  let partial = false;
  for (const candidate of value.hosts) {
    const host = objectValue(candidate, "host");
    const rawKind = safeString(host.kind, "host.kind");
    const kind = rawKind === "environment" ? "runtime" : rawKind;
    if (kind !== "local" && kind !== "ssh" && kind !== "runtime") {
      // An unknown host kind is dropped, but the source must still be marked
      // partial rather than silently losing coverage.
      partial = true;
      continue;
    }
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
  return { hosts, partial };
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
    const worktreeId = safeWorktreeId(worktree.worktreeId, "worktree.worktreeId");
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
    } else if (worktree.agents !== undefined) {
      // A non-array `agents` field is treated as no agents, but the source
      // must still be marked partial rather than silently losing coverage.
      partial = true;
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

const PARTIAL_REASON_RANK: Partial<Record<NonNullable<OrcaSourceReason>, number>> = {
  partial_records: 1,
  malformed: 2,
  privacy: 3,
};

// A later, milder fault must not hide a privacy rejection from the observation.
function markPartial(source: OrcaSourceObservation, reason: OrcaSourceReason): void {
  source.state = "partial";
  const current = source.reason === null ? 0 : PARTIAL_REASON_RANK[source.reason] ?? 0;
  const next = reason === null ? 0 : PARTIAL_REASON_RANK[reason] ?? 0;
  if (next >= current) source.reason = reason;
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
      const worktreeId = safeWorktreeId(terminal.worktreeId, "terminal.worktreeId");
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
            const unattributed = parseOwnSnapshot({
              ...existing,
              harness: null,
              status: "partial",
              provenance: { ...existing.provenance, completeness: "partial" },
            });
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
      const worktreeQualifiedId = qualifyWorktree("orca", worktreeId);
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
      const parsed = parseOwnSnapshot(record);
      records.push(parsed);
      metadata[parsed.record_id] = {
        terminalHandle: handle,
        worktreeId: worktreeQualifiedId,
        agentType,
        placement: executionHostCandidate === null ? "unknown" : placementKind(executionSourceId),
        observedAt: collectedAt,
      };
    } catch (error) {
      // A source data/privacy fault stays partial; a contract rejection of
      // the adapter's own record arrives as OrcaInvariantError and must
      // propagate instead of surfacing as partial telemetry.
      if (error instanceof OrcaInvariantError) throw error;
      markPartial(source, error instanceof PrivacyError ? "privacy" : "partial_records");
    }
  }
  if (source.state === "partial") {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      records[index] = parseOwnSnapshot({
        ...record,
        status: "partial",
        provenance: { ...record.provenance, completeness: "partial" },
      });
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
    const reportedVersion = optionalSafeString(runtime.appVersion, "runtime.appVersion");
    version = reportedVersion !== null && supportedVersion(reportedVersion) ? reportedVersion : null;
    if (runtime.reachable !== true || runtime.state !== "ready") {
      status.observation.state = "unavailable";
      status.observation.reason = "runtime_unavailable";
      status.observation.provenance.completeness = "unavailable";
      return empty(runtimeId, version);
    }
    if (version === null) {
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
      const parsedHosts = parseHosts(hostSource.value);
      hosts = parsedHosts.hosts;
      if (parsedHosts.partial) markPartial(hostSource.observation, "partial_records");
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
    // Re-throw the adapter's own invariant failures instead of misreporting
    // a record-construction regression as a source data fault.
    if (error instanceof OrcaInvariantError) throw error;
    markPartial(terminalSource.observation, error instanceof PrivacyError ? "privacy" : "malformed");
    return { ...empty(runtimeId, version), hosts };
  }
}

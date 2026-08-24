/**
 * Adapter: OpenCode sessions (~/.local/share/opencode/opencode.db, sqlite).
 * Assistant messages carry tokens {input, output, reasoning, cache{read,write}},
 * modelID, providerID, measured cost, and an error object — all mapped now
 * (#37 post-merge audit: cost and error state were being discarded, and the
 * db primary-key id outranks any JSON-internal fallback).
 */
import { Database } from "bun:sqlite";
import { stableId, type ProviderEvent } from "./types";

export function opencodeEventsFromDb(
  db: Database,
  sinceMs?: number,
): ProviderEvent[] {
  const rows = db
    .query(
      `SELECT m.id AS row_id, m.data, m.session_id FROM message m
       WHERE json_extract(m.data, '$.role') = 'assistant'
         AND json_extract(m.data, '$.tokens') IS NOT NULL
         ${sinceMs !== undefined ? "AND json_extract(m.data, '$.time.created') >= $since" : ""}
       ORDER BY m.id`,
    )
    .all(...(sinceMs !== undefined ? [{ $since: sinceMs }] : [])) as Array<{
      row_id: string | number;
      data: string;
      session_id: string;
    }>;
  const out: ProviderEvent[] = [];
  for (const row of rows) {
    let rec: any;
    try {
      rec = JSON.parse(row.data);
    } catch {
      continue;
    }
    const t = rec.tokens ?? {};
    const errored =
      rec.error !== null && rec.error !== undefined && rec.error !== "";
    const cost = typeof rec.cost === "number" ? rec.cost : null;
    out.push({
      // The database primary key is authoritative (#41): two rows sharing a
      // JSON-internal id must stay distinct events, exactly the hazard the
      // Codex adapter fixed for inherited session_meta ids.
      eventId: stableId("opencode", String(row.row_id)),
      harness: "opencode",
      billingRoute: cost !== null && cost > 0 ? "metered" : "unknown",
      modelProvider: rec.providerID ?? "unknown",
      model: rec.modelID ?? "unknown",
      ts: rec.time?.created ? new Date(rec.time.created).toISOString() : null,
      status: errored ? "error" : "ok",
      retryOf: null,
      inputTokens: t.input ?? null,
      outputTokens: t.output ?? null,
      cacheReadTokens: t.cache?.read ?? null,
      cacheWriteTokens: t.cache?.write ?? null,
      reasoningTokens: t.reasoning ?? null,
      cashChargeUsd: cost,
      provenance: "opencode.db",
    });
  }
  return out;
}

export function opencodeEvents(
  dbPath: string,
  sinceMs?: number,
): ProviderEvent[] | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null; // db absent or locked: caller reports unknown, never zero
  }
  try {
    // The window filters at the storage layer — no full-store parse (#37 P2).
    return opencodeEventsFromDb(db, sinceMs);
  } finally {
    db.close();
  }
}

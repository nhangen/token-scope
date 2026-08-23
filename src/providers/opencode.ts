/**
 * Adapter: OpenCode sessions (~/.local/share/opencode/opencode.db, sqlite).
 * Assistant messages carry tokens {input, output, reasoning, cache{read,write}},
 * modelID and providerID. Requires bun:sqlite (the runtime token-scope ships on).
 */
import { Database } from "bun:sqlite";
import { stableId, type ProviderEvent } from "./types";

export function opencodeEventsFromDb(db: Database): ProviderEvent[] {
  const rows = db
    .query(
      `SELECT m.data, m.session_id FROM message m
       WHERE json_extract(m.data, '$.role') = 'assistant'
         AND json_extract(m.data, '$.tokens') IS NOT NULL`,
    )
    .all() as Array<{ data: string; session_id: string }>;
  const out: ProviderEvent[] = [];
  for (const [i, row] of rows.entries()) {
    let rec: any;
    try {
      rec = JSON.parse(row.data);
    } catch {
      continue;
    }
    const t = rec.tokens ?? {};
    out.push({
      eventId: stableId(
        "opencode",
        rec.id ?? `${row.session_id}:${rec.time?.created ?? ""}:${i}`,
      ),
      harness: "opencode",
      billingRoute: "unknown",
      modelProvider: rec.providerID ?? "unknown",
      model: rec.modelID ?? "unknown",
      ts: rec.time?.created ? new Date(rec.time.created).toISOString() : null,
      status: "ok",
      retryOf: null,
      inputTokens: t.input ?? null,
      outputTokens: t.output ?? null,
      cacheReadTokens: t.cache?.read ?? null,
      cacheWriteTokens: t.cache?.write ?? null,
      reasoningTokens: t.reasoning ?? null,
      cashChargeUsd: null,
      provenance: "opencode.db",
    });
  }
  return out;
}

export function opencodeEvents(dbPath: string): ProviderEvent[] | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null; // db absent or locked: caller reports unknown, never zero
  }
  try {
    return opencodeEventsFromDb(db);
  } finally {
    db.close();
  }
}

import type { Database } from "bun:sqlite";

/** Missing/null timestamps, exact SQL window boundaries, and ineligible controls. */
export function seedOpenCodeWindow(db: Database, cutoff: number) {
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
  const insert = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
  const base = { role: "assistant", modelID: "window-model", providerID: "opencode" };
  const records = [
    ["missing-time", { ...base, tokens: { input: 1000, output: 100 } }],
    ["null-time", { ...base, tokens: { input: 2000, output: 200 }, time: { created: null } }],
    ["before", { ...base, tokens: { input: 4000, output: 400 }, time: { created: cutoff - 1 } }],
    ["at", { ...base, tokens: { input: 10, output: 1 }, time: { created: cutoff } }],
    ["after", { ...base, tokens: { input: 20, output: 2 }, time: { created: cutoff + 1 } }],
    ["user", { ...base, role: "user", tokens: { input: 8000 } }],
    ["tokenless", base],
    ["null-tokens", { ...base, tokens: null }],
  ] as const;
  for (const [id, record] of records) insert.run(id, "window-session", JSON.stringify(record));
}

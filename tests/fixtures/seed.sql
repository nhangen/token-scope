PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS base_messages (
  uuid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT,
  timestamp INTEGER NOT NULL,
  message_type TEXT NOT NULL,
  parent_uuid TEXT
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  uuid TEXT PRIMARY KEY,
  cost_usd REAL,
  duration_ms INTEGER,
  message TEXT NOT NULL,
  model TEXT,
  timestamp INTEGER NOT NULL
);

-- PROJECT A: /Users/alice/projects/optin-monster-app/wp-content
-- Session sess-a1 (3 turns, recent)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a1-t1', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465600000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a1-t1', 0.0032, 1200, '{"usage":{"output_tokens":210,"input_tokens":150,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}', 'claude-sonnet-4-6', 1743465600000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a1-t2', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465700000, 'user', 'bm-a1-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a1-t2', 0.0089, 2800, '{"usage":{"output_tokens":850,"input_tokens":2100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"thinking","thinking":"This is a thinking block that helps me understand the problem before responding. I need to analyze the code structure and make appropriate edits."},{"type":"tool_use","name":"Read","input":{"file_path":"/Users/alice/projects/optin-monster-app/wp-content/plugins/omappv4-core/src/Checkout/Stripe.php"}},{"type":"tool_use","name":"Edit","input":{"file_path":"a.php","old_string":"x","new_string":"y"}},{"type":"text","text":"I have read the file and identified the necessary changes."}]}', 'claude-sonnet-4-6', 1743465700000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a1-t3', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465900000, 'user', 'bm-a1-t2');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a1-t3', 0.0210, 4500, '{"usage":{"output_tokens":1528,"input_tokens":3200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"This is a lengthy agent task description that describes a complex multi-step process for implementing a new feature. The task involves understanding the existing codebase, identifying integration points, modifying multiple files, writing tests, and deploying to production. Each step requires careful consideration of edge cases and potential side effects."}]}', 'claude-sonnet-4-6', 1743465900000);

-- Session sess-a2 (2 turns, recent)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a2-t1', 'sess-a2', '/Users/alice/projects/optin-monster-app/wp-content', 1743552000000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a2-t1', NULL, 800, '{"usage":{"output_tokens":420,"input_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Grep","input":{"pattern":"function.*test"}}]}', 'claude-sonnet-4-6', 1743552000000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a2-t2', 'sess-a2', '/Users/alice/projects/optin-monster-app/wp-content', 1743552120000, 'user', 'bm-a2-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a2-t2', 0.0055, 600, '{"usage":{"output_tokens":380,"input_tokens":400,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Here is the response text without any tool usage."}]}', 'claude-sonnet-4-6', 1743552120000);

-- PROJECT B: /Users/alice/projects/token-scope
-- Session sess-b1 (2 turns, recent, haiku model)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-b1-t1', 'sess-b1', '/Users/alice/projects/token-scope', 1743638400000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-b1-t1', 0.0008, 400, '{"usage":{"output_tokens":77,"input_tokens":300,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"tool_use","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test --watch"}}]}', 'claude-haiku-4-5-20251001', 1743638400000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-b1-t2', 'sess-b1', '/Users/alice/projects/token-scope', 1743638500000, 'user', 'bm-b1-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-b1-t2', 0.0012, 350, '{"usage":{"output_tokens":145,"input_tokens":250,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"Response text here."}]}', 'claude-haiku-4-5-20251001', 1743638500000);

-- PROJECT C: /Users/alice/projects/beacon
-- Session sess-c1 (2 turns, OLD timestamp - excluded by default --since 30d)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-c1-t1', 'sess-c1', '/Users/alice/projects/beacon', 1738368000000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-c1-t1', 0.0041, 600, '{"usage":{"output_tokens":310,"input_tokens":400,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"git log --oneline"}}]}', 'claude-sonnet-4-6', 1738368000000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-c1-t2', 'sess-c1', '/Users/alice/projects/beacon', 1738368100000, 'user', 'bm-c1-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-c1-t2', 0.0028, 500, '{"usage":{"output_tokens":195,"input_tokens":300,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Final response."}]}', 'claude-sonnet-4-6', 1738368100000);

-- MALFORMED JSON ROW (recent timestamp, excluded by json_valid() guard)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-bad-1', 'sess-bad', '/Users/alice/projects/token-scope', 1743725000000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-bad-1', 0.0010, 200, 'NOT_VALID_JSON{{{', 'claude-sonnet-4-6', 1743725000000);

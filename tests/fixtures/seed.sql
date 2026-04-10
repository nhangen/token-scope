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
VALUES ('bm-a1-t1', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465600, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a1-t1', 0.0032, 1200, '{"usage":{"output_tokens":210,"input_tokens":150,"cache_read_input_tokens":0,"cache_creation_input_tokens":5000},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}', 'claude-sonnet-4-6', 1743465600);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a1-t2', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465700, 'user', 'bm-a1-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a1-t2', 0.0089, 2800, '{"usage":{"output_tokens":850,"input_tokens":2100,"cache_read_input_tokens":5000,"cache_creation_input_tokens":2000},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"thinking","thinking":"This is a thinking block that helps me understand the problem before responding. I need to analyze the code structure and make appropriate edits."},{"type":"tool_use","name":"Read","input":{"file_path":"/Users/alice/projects/optin-monster-app/wp-content/plugins/omappv4-core/src/Checkout/Stripe.php"}},{"type":"tool_use","name":"Edit","input":{"file_path":"a.php","old_string":"x","new_string":"y"}},{"type":"text","text":"I have read the file and identified the necessary changes."}]}', 'claude-sonnet-4-6', 1743465700);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a1-t3', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465900, 'user', 'bm-a1-t2');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a1-t3', 0.0210, 4500, '{"usage":{"output_tokens":1528,"input_tokens":3200,"cache_read_input_tokens":7000,"cache_creation_input_tokens":1500},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"This is a lengthy agent task description that describes a complex multi-step process for implementing a new feature. The task involves understanding the existing codebase, identifying integration points, modifying multiple files, writing tests, and deploying to production. Each step requires careful consideration of edge cases and potential side effects."}]}', 'claude-sonnet-4-6', 1743465900);

-- Session sess-a2 (2 turns, recent)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a2-t1', 'sess-a2', '/Users/alice/projects/optin-monster-app/wp-content', 1743552000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a2-t1', NULL, 800, '{"usage":{"output_tokens":420,"input_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Grep","input":{"pattern":"function.*test"}}]}', 'claude-sonnet-4-6', 1743552000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-a2-t2', 'sess-a2', '/Users/alice/projects/optin-monster-app/wp-content', 1743552120, 'user', 'bm-a2-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-a2-t2', 0.0055, 600, '{"usage":{"output_tokens":380,"input_tokens":400,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Here is the response text without any tool usage."}]}', 'claude-sonnet-4-6', 1743552120);

-- PROJECT B: /Users/alice/projects/token-scope
-- Session sess-b1 (2 turns, recent, haiku model)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-b1-t1', 'sess-b1', '/Users/alice/projects/token-scope', 1743638400, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-b1-t1', 0.0008, 400, '{"usage":{"output_tokens":77,"input_tokens":300,"cache_read_input_tokens":0,"cache_creation_input_tokens":3000},"stop_reason":"tool_use","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test --watch"}}]}', 'claude-haiku-4-5-20251001', 1743638400);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-b1-t2', 'sess-b1', '/Users/alice/projects/token-scope', 1743638500, 'user', 'bm-b1-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-b1-t2', 0.0012, 350, '{"usage":{"output_tokens":145,"input_tokens":250,"cache_read_input_tokens":3000,"cache_creation_input_tokens":500},"stop_reason":"end_turn","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"Response text here."}]}', 'claude-haiku-4-5-20251001', 1743638500);

-- PROJECT C: /Users/alice/projects/beacon
-- Session sess-c1 (2 turns, OLD timestamp - excluded by default --since 30d)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-c1-t1', 'sess-c1', '/Users/alice/projects/beacon', 1738368000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-c1-t1', 0.0041, 600, '{"usage":{"output_tokens":310,"input_tokens":400,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"git log --oneline"}}]}', 'claude-sonnet-4-6', 1738368000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-c1-t2', 'sess-c1', '/Users/alice/projects/beacon', 1738368100, 'user', 'bm-c1-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-c1-t2', 0.0028, 500, '{"usage":{"output_tokens":195,"input_tokens":300,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Final response."}]}', 'claude-sonnet-4-6', 1738368100);

-- PROJECT D: /Users/alice/projects/widget-app
-- Session sess-d1 (10 turns, realistic cache growth pattern)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t1', 'sess-d1', '/Users/alice/projects/widget-app', 1743724800, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t1', 0.01, 1500, '{"usage":{"output_tokens":200,"input_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":20000},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"I will help you build the widget-app feature. Let me start by understanding the project structure."}]}', 'claude-sonnet-4-6', 1743724800);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t2', 'sess-d1', '/Users/alice/projects/widget-app', 1743724900, 'user', 'bm-d1-t1');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t2', 0.02, 1800, '{"usage":{"output_tokens":300,"input_tokens":4,"cache_read_input_tokens":20000,"cache_creation_input_tokens":3000},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/alice/projects/widget-app/src/index.ts"}}]}', 'claude-sonnet-4-6', 1743724900);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t3', 'sess-d1', '/Users/alice/projects/widget-app', 1743725000, 'user', 'bm-d1-t2');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t3', 0.02, 1200, '{"usage":{"output_tokens":150,"input_tokens":4,"cache_read_input_tokens":23000,"cache_creation_input_tokens":500},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}', 'claude-sonnet-4-6', 1743725000);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t4', 'sess-d1', '/Users/alice/projects/widget-app', 1743725100, 'user', 'bm-d1-t3');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t4', 0.03, 2200, '{"usage":{"output_tokens":400,"input_tokens":6,"cache_read_input_tokens":23500,"cache_creation_input_tokens":1200},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/alice/projects/widget-app/src/components/Widget.tsx"}}]}', 'claude-sonnet-4-6', 1743725100);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t5', 'sess-d1', '/Users/alice/projects/widget-app', 1743725200, 'user', 'bm-d1-t4');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t5', 0.03, 1600, '{"usage":{"output_tokens":250,"input_tokens":4,"cache_read_input_tokens":24700,"cache_creation_input_tokens":800},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Grep","input":{"pattern":"export.*Widget","path":"/Users/alice/projects/widget-app/src"}}]}', 'claude-sonnet-4-6', 1743725200);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t6', 'sess-d1', '/Users/alice/projects/widget-app', 1743725300, 'user', 'bm-d1-t5');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t6', 0.04, 2800, '{"usage":{"output_tokens":500,"input_tokens":6,"cache_read_input_tokens":25500,"cache_creation_input_tokens":5000},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/alice/projects/widget-app/src/utils/helpers.ts"}}]}', 'claude-sonnet-4-6', 1743725300);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t7', 'sess-d1', '/Users/alice/projects/widget-app', 1743725400, 'user', 'bm-d1-t6');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t7', 0.04, 1400, '{"usage":{"output_tokens":180,"input_tokens":4,"cache_read_input_tokens":30500,"cache_creation_input_tokens":400},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"bun run build"}}]}', 'claude-sonnet-4-6', 1743725400);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t8', 'sess-d1', '/Users/alice/projects/widget-app', 1743725500, 'user', 'bm-d1-t7');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t8', 0.05, 1100, '{"usage":{"output_tokens":120,"input_tokens":4,"cache_read_input_tokens":30900,"cache_creation_input_tokens":300},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"The build completed successfully. All type checks passed."}]}', 'claude-sonnet-4-6', 1743725500);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t9', 'sess-d1', '/Users/alice/projects/widget-app', 1743725600, 'user', 'bm-d1-t8');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t9', 0.06, 2500, '{"usage":{"output_tokens":350,"input_tokens":6,"cache_read_input_tokens":31200,"cache_creation_input_tokens":2000},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/Users/alice/projects/widget-app/src/components/Widget.tsx","old_string":"return null","new_string":"return <div>Widget</div>"}}]}', 'claude-sonnet-4-6', 1743725600);

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-d1-t10', 'sess-d1', '/Users/alice/projects/widget-app', 1743725700, 'user', 'bm-d1-t9');

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-d1-t10', 0.08, 900, '{"usage":{"output_tokens":100,"input_tokens":4,"cache_read_input_tokens":33200,"cache_creation_input_tokens":100},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"The widget component is now fully implemented and tested."}]}', 'claude-sonnet-4-6', 1743725700);

-- MALFORMED JSON ROW (recent timestamp, excluded by json_valid() guard)

INSERT INTO base_messages (uuid, session_id, cwd, timestamp, message_type, parent_uuid)
VALUES ('bm-bad-1', 'sess-bad', '/Users/alice/projects/token-scope', 1743725000, 'user', NULL);

INSERT INTO assistant_messages (uuid, cost_usd, duration_ms, message, model, timestamp)
VALUES ('bm-bad-1', 0.0010, 200, 'NOT_VALID_JSON{{{', 'claude-sonnet-4-6', 1743725000);

# token-scope Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency CLI tool that reads `~/.claude/__store.db` in read-only mode and renders rich terminal token analytics reports.

**Architecture:** Single-direction data flow: SQLite → `parse.ts` (pure utils) → `db.ts` (all SQL) → `reports/` (formatting) → `cli.ts` (entry point). No aggregation DB; every invocation queries live. Bun runtime with `bun:sqlite` built-in; no npm runtime dependencies.

**Tech Stack:** Bun 1.1.0+, TypeScript, `bun:sqlite` (built-in), `bun test` (built-in runner)

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `package.json` | Project metadata, bin entry, devDeps only |
| Create | `tsconfig.json` | Strict TypeScript, ESNext, path aliases |
| Create | `bunfig.toml` | Test preload: `TOKEN_SCOPE_DB` → fixture path |
| Create | `.tool-versions` | Pin Bun 1.1.0 for asdf/mise |
| Create | `src/parse.ts` | Pure utilities: dominant tool, thinking estimation, Bash categorization |
| Create | `src/pricing.ts` | Static model → price map; cache savings computation |
| Create | `src/db.ts` | All SQL; typed query functions; read-only open; DB path resolution |
| Create | `src/format.ts` | Terminal table builder, ANSI helpers, number/duration formatters |
| Create | `src/cli.ts` | Entry point: argv parsing, mutual exclusion, DB path resolution, routing |
| Create | `src/reports/summary.ts` | Main aggregate report |
| Create | `src/reports/tool.ts` | Tool drill-down |
| Create | `src/reports/project.ts` | Project drill-down + multi-match disambiguation |
| Create | `src/reports/session.ts` | Turn-by-turn view + `--sessions` list |
| Create | `src/reports/thinking.ts` | Thinking-focused analysis |
| Create | `tests/fixtures/seed.sql` | Reproducible INSERT statements for fixture DB |
| Create | `tests/fixtures/__store.db` | Synthetic SQLite DB generated from seed.sql |
| Create | `tests/parse.test.ts` | Unit tests for all parse.ts functions |
| Create | `tests/db.test.ts` | Integration tests: query shapes, time filters, json_valid guard |
| Create | `tests/reports.test.ts` | Smoke tests: all reports render; JSON output valid |
| Create | `skill/SKILL.md` | Claude Code skill manifest |
| Create | `.github/workflows/ci.yml` | Push/PR: `bun test` + `bun tsc --noEmit` |
| Create | `.github/workflows/release.yml` | `v*` tag: test gate → 3-target binary matrix → GitHub Release |
| Create | `README.md` | Install, usage, environment variables, screenshots |
| Create | `CHANGELOG.md` | Keep a Changelog initial entry |

---

## Task 1: Repo Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `.tool-versions`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "token-scope",
  "version": "1.0.0",
  "description": "Analytics for Claude Code output token spend. Reads ~/.claude/__store.db in read-only mode.",
  "bin": {
    "token-scope": "./src/cli.ts"
  },
  "scripts": {
    "typecheck": "bun tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/bun": "latest"
  },
  "engines": {
    "bun": ">=1.1.0"
  },
  "keywords": ["claude-code", "tokens", "analytics", "sqlite"],
  "license": "MIT"
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    },
    "types": ["bun-types"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create `bunfig.toml`**

This auto-sets `TOKEN_SCOPE_DB` for all `bun test` runs so tests never accidentally hit a real user's database.

```toml
[test]
preload = ["./tests/setup.ts"]
```

Create `tests/setup.ts`:

```typescript
// Preloaded before every bun test run.
// Points TOKEN_SCOPE_DB at the fixture so tests never touch a real user's database.
process.env["TOKEN_SCOPE_DB"] = new URL("./fixtures/__store.db", import.meta.url).pathname;
```

- [ ] **Step 4: Create `.tool-versions`**

```
bun 1.1.0
```

- [ ] **Step 5: Create `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to token-scope are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Phase 1: terminal reports (summary, tool, project, session, thinking, sessions list)
- Read-only access to `~/.claude/__store.db` via `bun:sqlite`
- `--since`, `--limit`, `--json`, `--db`, `--version`, `--help` flags
- Claude Code skill wrapper (`skill/SKILL.md`)
- Pricing constants for cache savings estimation (`src/pricing.ts`)
- Full test suite with fixture database
- CI via GitHub Actions
```

- [ ] **Step 6: Install dev dependencies**

```bash
cd ~/ML-AI/token-scope
bun install
```

Expected output:
```
bun install v1.x.x
+ @types/bun@...
+ typescript@...
2 packages installed
```

- [ ] **Step 7: Verify TypeScript check works on empty project**

```bash
bun tsc --noEmit
```

Expected: exits 0 (no source files yet, no errors).

- [ ] **Step 8: Commit scaffold**

```bash
git add package.json tsconfig.json bunfig.toml .tool-versions CHANGELOG.md tests/setup.ts
git commit -m "Initialize repo scaffold with TypeScript, Bun, and test preload config"
```


---

## Task 2: Fixture Database

**Files:**
- Create: `tests/fixtures/seed.sql`
- Create: `tests/fixtures/__store.db` (generated)

The fixture must contain:
- 3 projects (distinct `cwd` paths)
- Turns in the last 30 days AND turns >30 days old (to test time filters)
- Turns with thinking blocks
- Turns with multiple tool_use blocks (to test dominant-tool resolution)
- One row with malformed JSON in `message` (to test `json_valid` guard)
- Rows with `NULL` `cost_usd` (to test NULL handling)
- Multiple sessions per project

- [ ] **Step 1: Create `tests/fixtures/seed.sql`**

```sql
-- token-scope fixture database
-- Run: sqlite3 tests/fixtures/__store.db < tests/fixtures/seed.sql
-- Schema mirrors ~/.claude/__store.db (Claude Code internal database)

PRAGMA journal_mode=WAL;

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

-- Epoch ms for 2026-04-01 00:00:00 UTC: 1743465600000
-- Epoch ms for 2026-02-01 00:00:00 UTC: 1738368000000

-- PROJECT A: /Users/alice/projects/optin-monster-app/wp-content
-- SESSION 1 (recent, 3 turns, one thinking turn)
INSERT INTO base_messages VALUES
  ('bm-a1-t1', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465600000, 'assistant', NULL),
  ('bm-a1-t2', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465700000, 'assistant', 'bm-a1-t1'),
  ('bm-a1-t3', 'sess-a1', '/Users/alice/projects/optin-monster-app/wp-content', 1743465900000, 'assistant', 'bm-a1-t2');

-- Turn 1: Bash (git status)
INSERT INTO assistant_messages VALUES (
  'bm-a1-t1', 0.0032, 1200,
  '{"usage":{"output_tokens":210,"input_tokens":3,"cache_read_input_tokens":42000,"cache_creation_input_tokens":500},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}},{"type":"text","text":"Let me check the repo status."}]}',
  'claude-sonnet-4-6', 1743465600000
);

-- Turn 2: Read + Edit (multi-tool), with thinking block. Read input is longer -> Read is dominant.
INSERT INTO assistant_messages VALUES (
  'bm-a1-t2', 0.0089, 3100,
  '{"usage":{"output_tokens":850,"input_tokens":5,"cache_read_input_tokens":43200,"cache_creation_input_tokens":1200},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"thinking","thinking":"Let me analyze the file structure carefully to understand what changes are needed in the authentication flow. There are several paths through the code and I need to trace each one."},{"type":"tool_use","name":"Read","input":{"file_path":"/Users/alice/projects/optin-monster-app/wp-content/plugins/omappv4-core/src/Checkout/Stripe.php","limit":200}},{"type":"tool_use","name":"Edit","input":{"file_path":"a.php","old_string":"x","new_string":"y"}},{"type":"text","text":"I have updated the return value."}]}',
  'claude-sonnet-4-6', 1743465700000
);

-- Turn 3: Agent (long task input)
INSERT INTO assistant_messages VALUES (
  'bm-a1-t3', 0.0210, 8900,
  '{"usage":{"output_tokens":1528,"input_tokens":2,"cache_read_input_tokens":46000,"cache_creation_input_tokens":2600},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Agent","input":{"description":"Analyze the full billing flow in wp-content, trace every Stripe webhook handler, document the reconciliation logic, and identify any gaps in the subscription renewal path."}},{"type":"text","text":"Dispatching a subagent to analyze the billing flow."}]}',
  'claude-sonnet-4-6', 1743465900000
);

-- SESSION 2 (recent, 2 turns, NULL cost_usd on one row)
INSERT INTO base_messages VALUES
  ('bm-a2-t1', 'sess-a2', '/Users/alice/projects/optin-monster-app/wp-content', 1743552000000, 'assistant', NULL),
  ('bm-a2-t2', 'sess-a2', '/Users/alice/projects/optin-monster-app/wp-content', 1743552120000, 'assistant', 'bm-a2-t1');

INSERT INTO assistant_messages VALUES (
  'bm-a2-t1', NULL, 2200,
  '{"usage":{"output_tokens":420,"input_tokens":4,"cache_read_input_tokens":41000,"cache_creation_input_tokens":800},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Grep","input":{"pattern":"function processWebhook","path":"."}},{"type":"text","text":"Searching for webhook handler."}]}',
  'claude-sonnet-4-6', 1743552000000
);

INSERT INTO assistant_messages VALUES (
  'bm-a2-t2', 0.0055, 1900,
  '{"usage":{"output_tokens":380,"input_tokens":3,"cache_read_input_tokens":42500,"cache_creation_input_tokens":600},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"The webhook handler is located in Stripe.php line 142."}]}',
  'claude-sonnet-4-6', 1743552120000
);

-- PROJECT B: /Users/alice/projects/token-scope (haiku model)
INSERT INTO base_messages VALUES
  ('bm-b1-t1', 'sess-b1', '/Users/alice/projects/token-scope', 1743638400000, 'assistant', NULL),
  ('bm-b1-t2', 'sess-b1', '/Users/alice/projects/token-scope', 1743638500000, 'assistant', 'bm-b1-t1');

INSERT INTO assistant_messages VALUES (
  'bm-b1-t1', 0.0008, 800,
  '{"usage":{"output_tokens":77,"input_tokens":2,"cache_read_input_tokens":12000,"cache_creation_input_tokens":200},"stop_reason":"tool_use","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test --watch"}},{"type":"text","text":"Running tests."}]}',
  'claude-haiku-4-5-20251001', 1743638400000
);

INSERT INTO assistant_messages VALUES (
  'bm-b1-t2', 0.0012, 1100,
  '{"usage":{"output_tokens":145,"input_tokens":3,"cache_read_input_tokens":13500,"cache_creation_input_tokens":300},"stop_reason":"end_turn","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"All 12 tests passed. The fixture database seed is working correctly."}]}',
  'claude-haiku-4-5-20251001', 1743638500000
);

-- PROJECT C: /Users/alice/projects/beacon (OLD — >30 days, excluded by default --since 30d)
INSERT INTO base_messages VALUES
  ('bm-c1-t1', 'sess-c1', '/Users/alice/projects/beacon', 1738368000000, 'assistant', NULL),
  ('bm-c1-t2', 'sess-c1', '/Users/alice/projects/beacon', 1738368100000, 'assistant', 'bm-c1-t1');

INSERT INTO assistant_messages VALUES (
  'bm-c1-t1', 0.0041, 1500,
  '{"usage":{"output_tokens":310,"input_tokens":6,"cache_read_input_tokens":38000,"cache_creation_input_tokens":700},"stop_reason":"tool_use","model":"claude-sonnet-4-6","content":[{"type":"tool_use","name":"Bash","input":{"command":"git log --oneline -20"}},{"type":"text","text":"Checking recent commits."}]}',
  'claude-sonnet-4-6', 1738368000000
);

INSERT INTO assistant_messages VALUES (
  'bm-c1-t2', 0.0028, 1200,
  '{"usage":{"output_tokens":195,"input_tokens":4,"cache_read_input_tokens":36000,"cache_creation_input_tokens":400},"stop_reason":"end_turn","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Here are the last 20 commits."}]}',
  'claude-sonnet-4-6', 1738368100000
);

-- MALFORMED JSON ROW — excluded by json_valid() guard
INSERT INTO base_messages VALUES
  ('bm-bad-1', 'sess-bad', '/Users/alice/projects/optin-monster-app/wp-content', 1743725000000, 'assistant', NULL);

INSERT INTO assistant_messages VALUES (
  'bm-bad-1', 0.0010, 500, 'NOT_VALID_JSON{{{', 'claude-sonnet-4-6', 1743725000000
);
```

- [ ] **Step 2: Generate the fixture database**

```bash
cd ~/ML-AI/token-scope
mkdir -p tests/fixtures
sqlite3 tests/fixtures/__store.db < tests/fixtures/seed.sql
```

Verify:
```bash
sqlite3 tests/fixtures/__store.db "SELECT COUNT(*) FROM assistant_messages;"
```
Expected: `9`

```bash
sqlite3 tests/fixtures/__store.db "SELECT uuid, json_valid(message) FROM assistant_messages ORDER BY uuid;"
```
Expected: `bm-bad-1` shows `0`, all others `1`.

- [ ] **Step 3: Commit fixture**

```bash
git add tests/fixtures/seed.sql tests/fixtures/__store.db tests/setup.ts
git commit -m "Add fixture database with seed.sql: 3 projects, thinking turns, multi-tool, malformed JSON, NULL cost_usd"
```


---

## Task 3: `parse.ts` — Pure Utilities

**Files:**
- Create: `src/parse.ts`
- Create: `tests/parse.test.ts`

`parse.ts` is pure (no I/O, no imports from other project files). All functions accept `null | undefined` for optional fields and return typed defaults.

- [ ] **Step 1: Write failing tests**

Create `tests/parse.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { resolveDominantTool, estimateThinkingTokens, categorizeBashCommand } from "@/parse";
import type { ContentBlock } from "@/parse";

describe("resolveDominantTool", () => {
  it("returns '(text only)' when no tool_use blocks", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "Hello world" }];
    expect(resolveDominantTool(blocks)).toBe("(text only)");
  });

  it("returns the single tool when one tool_use block", () => {
    const blocks: ContentBlock[] = [{ type: "tool_use", name: "Bash", input: { command: "git status" } }];
    expect(resolveDominantTool(blocks)).toBe("Bash");
  });

  it("returns the tool with the largest JSON input", () => {
    // Read has longer input (long file_path) than Edit
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
      { type: "tool_use", name: "Read", input: { file_path: "/very/long/absolute/path/to/some/file/in/the/project.ts", limit: 200 } },
    ];
    expect(resolveDominantTool(blocks)).toBe("Read");
  });

  it("breaks ties alphabetically", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Zebra", input: { x: 1 } },
      { type: "tool_use", name: "Alpha", input: { x: 1 } },
    ];
    expect(resolveDominantTool(blocks)).toBe("Alpha");
  });

  it("ignores non-tool_use blocks in the calculation", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: "A very long thinking block with lots of characters that should not count toward tool dominance" },
      { type: "tool_use", name: "Glob", input: { pattern: "*.ts" } },
    ];
    expect(resolveDominantTool(blocks)).toBe("Glob");
  });

  it("returns '(text only)' for empty blocks array", () => {
    expect(resolveDominantTool([])).toBe("(text only)");
  });
});

describe("estimateThinkingTokens", () => {
  it("returns 0 when thinkingChars is 0", () => {
    expect(estimateThinkingTokens(0, 500, 300)).toBe(0);
  });

  it("returns null when both thinking and text chars are 0", () => {
    expect(estimateThinkingTokens(0, 0, 500)).toBeNull();
  });

  it("estimates proportionally for 50/50 split", () => {
    expect(estimateThinkingTokens(500, 500, 400)).toBe(200);
  });

  it("estimates correctly for all-thinking turn", () => {
    expect(estimateThinkingTokens(1000, 0, 300)).toBe(300);
  });

  it("rounds to nearest integer", () => {
    // 1/(1+2) * 100 = 33.33 -> 33
    expect(estimateThinkingTokens(1, 2, 100)).toBe(33);
  });
});

describe("categorizeBashCommand", () => {
  it("categorizes git commands", () => {
    expect(categorizeBashCommand("git status")).toBe("Version Control");
    expect(categorizeBashCommand("git log --oneline -20")).toBe("Version Control");
  });

  it("categorizes JS tooling", () => {
    expect(categorizeBashCommand("npm run test")).toBe("JS Tooling");
    expect(categorizeBashCommand("bun install")).toBe("JS Tooling");
    expect(categorizeBashCommand("npx playwright test")).toBe("JS Tooling");
  });

  it("categorizes PHP tooling", () => {
    expect(categorizeBashCommand("composer install")).toBe("PHP Tooling");
    expect(categorizeBashCommand("phpunit tests/")).toBe("PHP Tooling");
  });

  it("categorizes HTTP/network", () => {
    expect(categorizeBashCommand("curl -s https://api.example.com")).toBe("HTTP / Network");
    expect(categorizeBashCommand("wget https://example.com/file.zip")).toBe("HTTP / Network");
  });

  it("categorizes containers", () => {
    expect(categorizeBashCommand("docker build .")).toBe("Containers");
    expect(categorizeBashCommand("kubectl get pods")).toBe("Containers");
  });

  it("categorizes Python tooling", () => {
    expect(categorizeBashCommand("python3 script.py")).toBe("Python Tooling");
    expect(categorizeBashCommand("pytest tests/")).toBe("Python Tooling");
  });

  it("categorizes file inspection", () => {
    expect(categorizeBashCommand("ls -la")).toBe("File Inspection");
    expect(categorizeBashCommand("grep -r 'pattern' .")).toBe("File Inspection");
  });

  it("categorizes file mutation", () => {
    expect(categorizeBashCommand("mkdir -p src/reports")).toBe("File Mutation");
    expect(categorizeBashCommand("rm -rf dist/")).toBe("File Mutation");
  });

  it("categorizes by first command in a chain", () => {
    expect(categorizeBashCommand("cd /tmp && git status")).toBe("Version Control");
  });

  it("strips leading env assignments", () => {
    expect(categorizeBashCommand("export PATH=/foo:$PATH; git push")).toBe("Version Control");
  });

  it("returns Other for unknown commands", () => {
    expect(categorizeBashCommand("unknown-tool --flag")).toBe("Other");
    expect(categorizeBashCommand("")).toBe("Other");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd ~/ML-AI/token-scope && bun test tests/parse.test.ts
```

Expected: FAIL — `Cannot find module '@/parse'`

- [ ] **Step 3: Implement `src/parse.ts`**

```typescript
export interface ContentBlock {
  type: "text" | "tool_use" | "thinking" | string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
}

/**
 * Returns the dominant tool in a turn (tool_use block with largest JSON.stringify(input) length).
 * Ties broken alphabetically. Returns "(text only)" when no tool_use blocks present.
 */
export function resolveDominantTool(blocks: ContentBlock[]): string {
  const toolBlocks = blocks.filter((b) => b.type === "tool_use" && b.name);
  if (toolBlocks.length === 0) return "(text only)";

  let dominant = toolBlocks[0]!;
  let dominantSize = JSON.stringify(dominant.input ?? {}).length;

  for (let i = 1; i < toolBlocks.length; i++) {
    const block = toolBlocks[i]!;
    const size = JSON.stringify(block.input ?? {}).length;
    if (size > dominantSize || (size === dominantSize && (block.name ?? "") < (dominant.name ?? ""))) {
      dominant = block;
      dominantSize = size;
    }
  }

  return dominant.name ?? "(text only)";
}

/**
 * Estimates thinking tokens using a character-ratio proxy (±15-30% error).
 * Returns null for tool-only turns (both chars zero).
 * Returns 0 when thinkingChars is zero.
 * All callers must prefix output with "~".
 */
export function estimateThinkingTokens(
  thinkingChars: number,
  textChars: number,
  outputTokens: number
): number | null {
  if (thinkingChars === 0 && textChars === 0) return null;
  if (thinkingChars === 0) return 0;
  const ratio = thinkingChars / (thinkingChars + textChars);
  return Math.round(ratio * outputTokens);
}

const BASH_CATEGORIES: Array<[RegExp, string]> = [
  [/^git\b/, "Version Control"],
  [/^(npm|npx|yarn|pnpm|bun)\b/, "JS Tooling"],
  [/^(composer|php\b|phpunit|phpspec)\b/, "PHP Tooling"],
  [/^(curl|wget)\b/, "HTTP / Network"],
  [/^(docker|kubectl)\b/, "Containers"],
  [/^(python|python3|pytest)\b/, "Python Tooling"],
  [/^(ls|find|cat|grep|rg)\b/, "File Inspection"],
  [/^(mkdir|rm|cp|mv|chmod)\b/, "File Mutation"],
];

/**
 * Categorizes a Bash command by its first meaningful token.
 * Strips: "cd /path &&", "export VAR=val;", "sudo".
 * Multi-command chains categorized by first command.
 */
export function categorizeBashCommand(command: string): string {
  if (!command.trim()) return "Other";
  let segment = command.split(/\s*&&\s*/)[0] ?? command;
  segment = segment.trim();
  segment = segment.replace(/^(export\s+)?[A-Z_][A-Z0-9_]*=[^\s;]+\s*;?\s*/gi, "").trim();
  segment = segment.replace(/^cd\s+\S+\s*/, "").trim();
  segment = segment.replace(/^sudo\s+/, "").trim();
  const firstToken = segment.split(/\s+/)[0] ?? "";
  for (const [pattern, category] of BASH_CATEGORIES) {
    if (pattern.test(firstToken)) return category;
  }
  return "Other";
}

/** Parses content blocks from raw message JSON. Returns [] on failure. */
export function parseContentBlocks(messageJson: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(messageJson) as { content?: unknown };
    if (!Array.isArray(parsed.content)) return [];
    return parsed.content as ContentBlock[];
  } catch {
    return [];
  }
}

/** Extracts usage fields from raw message JSON. Returns zeros on failure. */
export function parseUsage(messageJson: string): {
  outputTokens: number; inputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
} {
  const defaults = { outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  try {
    const parsed = JSON.parse(messageJson) as { usage?: Record<string, number> };
    const u = parsed.usage ?? {};
    return {
      outputTokens: u["output_tokens"] ?? 0,
      inputTokens: u["input_tokens"] ?? 0,
      cacheReadTokens: u["cache_read_input_tokens"] ?? 0,
      cacheWriteTokens: u["cache_creation_input_tokens"] ?? 0,
    };
  } catch {
    return defaults;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test tests/parse.test.ts
```

Expected: 18 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/parse.ts tests/parse.test.ts
git commit -m "Add parse.ts pure utilities with full test coverage"
```


---

## Task 4: `pricing.ts` — Model Pricing Constants

**Files:**
- Create: `src/pricing.ts`
- Modify: `tests/parse.test.ts` (add pricing tests at bottom)

- [ ] **Step 1: Add pricing tests to `tests/parse.test.ts`**

Append to the existing file:

```typescript
import { getPricing, computeCacheSavings } from "@/pricing";

describe("getPricing", () => {
  it("returns pricing for a known model", () => {
    const p = getPricing("claude-sonnet-4-6");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(3.00);
    expect(p!.cacheReadPerMillion).toBe(0.30);
    expect(p!.outputPerMillion).toBe(15.00);
  });

  it("returns null for an unknown model", () => {
    expect(getPricing("claude-unknown-99")).toBeNull();
  });

  it("returns pricing for haiku", () => {
    expect(getPricing("claude-haiku-4-5-20251001")!.outputPerMillion).toBe(4.00);
  });
});

describe("computeCacheSavings", () => {
  it("calculates savings for a known model", () => {
    // sonnet: (3.00 - 0.30) = 2.70 per million
    const savings = computeCacheSavings("claude-sonnet-4-6", 1_000_000);
    expect(savings).toBeCloseTo(2.70, 4);
  });

  it("returns null for an unknown model", () => {
    expect(computeCacheSavings("unknown-model", 1_000_000)).toBeNull();
  });

  it("returns 0 for zero cache read tokens", () => {
    expect(computeCacheSavings("claude-sonnet-4-6", 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run new tests to confirm they fail**

```bash
bun test tests/parse.test.ts 2>&1 | grep -E "fail|Cannot find"
```

Expected: `Cannot find module '@/pricing'`

- [ ] **Step 3: Implement `src/pricing.ts`**

```typescript
export interface ModelPricing {
  inputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
  outputPerMillion: number;
}

// Prices are per million tokens (USD). Source: Anthropic pricing as of 2026-04-07.
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":            { inputPerMillion: 15.00, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50,  outputPerMillion: 75.00 },
  "claude-sonnet-4-6":          { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-haiku-4-5-20251001":  { inputPerMillion:  0.80, cacheWritePerMillion:  1.00, cacheReadPerMillion: 0.08,  outputPerMillion:  4.00 },
  "claude-3-7-sonnet-20250219": { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-3-5-haiku-20241022":  { inputPerMillion:  0.80, cacheWritePerMillion:  1.00, cacheReadPerMillion: 0.08,  outputPerMillion:  4.00 },
  "claude-3-5-sonnet-20241022": { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-3-opus-20240229":     { inputPerMillion: 15.00, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50,  outputPerMillion: 75.00 },
};

let overrideMap: Record<string, ModelPricing> | null = null;

function loadPricingMap(): Record<string, ModelPricing> {
  if (overrideMap !== null) return overrideMap;
  const overridePath = process.env["TOKEN_SCOPE_PRICING_FILE"];
  if (overridePath) {
    try {
      const raw = require("fs").readFileSync(overridePath, "utf8") as string;
      overrideMap = JSON.parse(raw) as Record<string, ModelPricing>;
      return overrideMap;
    } catch (e) {
      process.stderr.write(`Warning: Could not load TOKEN_SCOPE_PRICING_FILE at "${overridePath}": ${String(e)}\n`);
    }
  }
  overrideMap = PRICING;
  return PRICING;
}

/** Returns pricing for a model, or null if the model is not in the map. */
export function getPricing(model: string): ModelPricing | null {
  return loadPricingMap()[model] ?? null;
}

/**
 * Estimates cache savings: cacheReadTokens * (inputPrice - cacheReadPrice) / 1_000_000
 * Returns null if model pricing is unknown.
 */
export function computeCacheSavings(model: string, cacheReadTokens: number): number | null {
  const p = getPricing(model);
  if (!p) return null;
  return (cacheReadTokens * (p.inputPerMillion - p.cacheReadPerMillion)) / 1_000_000;
}
```

- [ ] **Step 4: Run all tests**

```bash
bun test tests/parse.test.ts
```

Expected: 24 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts tests/parse.test.ts
git commit -m "Add pricing constants and cache savings computation with tests"
```


---

## Task 5: `db.ts` — Database Layer

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

`db.ts` owns all SQL. It opens the DB read-only and never throws on missing fields. Every `json_each` query guards with `WHERE json_valid(am.message) = 1`.

- [ ] **Step 1: Write failing db tests**

Create `tests/db.test.ts`:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { openDb, resolveDbPath, querySummaryTotals, queryByTool, queryByProject, querySessions, querySessionTurns } from "@/db";
import type { Database } from "bun:sqlite";

let db: Database;

beforeAll(() => { db = openDb(resolveDbPath().path); });
afterAll(() => { db.close(); });

describe("resolveDbPath", () => {
  it("returns source 'env' when TOKEN_SCOPE_DB is set", () => {
    const result = resolveDbPath();
    expect(result.source).toBe("env");
    expect(result.path).toContain("__store.db");
  });
});

describe("querySummaryTotals", () => {
  it("returns correct shape with numeric fields", () => {
    const result = querySummaryTotals(db, 0);
    expect(result).toHaveProperty("totalOutputTokens");
    expect(result).toHaveProperty("totalCostUsd");
    expect(result).toHaveProperty("sessionCount");
    expect(result).toHaveProperty("turnCount");
    expect(typeof result.totalOutputTokens).toBe("number");
    expect(typeof result.sessionCount).toBe("number");
  });

  it("excludes the malformed-JSON row from token counts", () => {
    const all = querySummaryTotals(db, 0);
    // 8 valid rows: 210+850+1528+420+380+77+145+310+195 = 4115
    // malformed row has no parseable tokens so json_valid guard excludes it
    expect(all.totalOutputTokens).toBe(4115);
  });

  it("time filter excludes old sessions", () => {
    // 2026-03-01 00:00:00 UTC in ms
    const result = querySummaryTotals(db, 1740787200000);
    // Old session (sess-c1) had 310+195=505 tokens — excluded
    // Recent: 210+850+1528+420+380+77+145 = 3610
    expect(result.totalOutputTokens).toBe(3610);
  });
});

describe("queryByTool", () => {
  it("returns rows sorted by output tokens desc", () => {
    const rows = queryByTool(db, 0, 20);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.outputTokens).toBeGreaterThanOrEqual(rows[i]!.outputTokens);
    }
  });

  it("each row has required fields", () => {
    const rows = queryByTool(db, 0, 20);
    for (const row of rows) {
      expect(row).toHaveProperty("tool");
      expect(row).toHaveProperty("turns");
      expect(row).toHaveProperty("outputTokens");
      expect(row).toHaveProperty("totalCostUsd");
      expect(typeof row.tool).toBe("string");
    }
  });
});

describe("queryByProject", () => {
  it("returns one row per distinct cwd", () => {
    const rows = queryByProject(db, 0, 20);
    const cwds = new Set(rows.map((r) => r.cwd));
    expect(cwds.size).toBe(rows.length);
  });

  it("includes session count and turn count", () => {
    const rows = queryByProject(db, 0, 20);
    for (const row of rows) {
      expect(row).toHaveProperty("sessions");
      expect(row).toHaveProperty("turns");
      expect(typeof row.sessions).toBe("number");
    }
  });
});

describe("querySessions", () => {
  it("returns sessions sorted by total cost desc", () => {
    const rows = querySessions(db, 0, 20);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i - 1]!.totalCostUsd ?? 0)).toBeGreaterThanOrEqual(rows[i]!.totalCostUsd ?? 0);
    }
  });

  it("each session row has required fields", () => {
    const rows = querySessions(db, 0, 20);
    for (const row of rows) {
      expect(row).toHaveProperty("sessionId");
      expect(row).toHaveProperty("cwd");
      expect(row).toHaveProperty("startedAt");
      expect(row).toHaveProperty("turnCount");
      expect(row).toHaveProperty("outputTokens");
    }
  });
});

describe("querySessionTurns", () => {
  it("returns turns in chronological order", () => {
    const turns = querySessionTurns(db, "sess-a1");
    expect(turns.length).toBe(3);
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i]!.timestamp).toBeGreaterThanOrEqual(turns[i - 1]!.timestamp);
    }
  });

  it("returns empty array for unknown session", () => {
    expect(querySessionTurns(db, "nonexistent-session-id")).toHaveLength(0);
  });

  it("each turn has message and outputTokens fields", () => {
    const turns = querySessionTurns(db, "sess-a1");
    for (const turn of turns) {
      expect(turn).toHaveProperty("message");
      expect(turn).toHaveProperty("outputTokens");
      expect(turn).toHaveProperty("costUsd");
    }
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test tests/db.test.ts
```

Expected: FAIL — `Cannot find module '@/db'`

- [ ] **Step 3: Implement `src/db.ts`**

```typescript
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbPathResult {
  path: string;
  source: "flag" | "env" | "xdg" | "default";
}

export interface SummaryTotals {
  totalOutputTokens: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number | null;
  sessionCount: number;
  turnCount: number;
  avgCostPerSession: number | null;
  avgCostPerTurn: number | null;
}

export interface ToolRow {
  tool: string;
  turns: number;
  outputTokens: number;
  outputPct: number;
  avgOutputPerTurn: number;
  totalCostUsd: number | null;
  costPct: number | null;
}

export interface ProjectRow {
  cwd: string;
  sessions: number;
  turns: number;
  outputTokens: number;
  totalCostUsd: number | null;
  avgSessionCost: number | null;
}

export interface SessionRow {
  sessionId: string;
  cwd: string | null;
  startedAt: number;
  durationMs: number | null;
  turnCount: number;
  outputTokens: number;
  cacheHitPct: number | null;
  totalCostUsd: number | null;
}

export interface TurnRow {
  uuid: string;
  timestamp: number;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  model: string | null;
  stopReason: string | null;
  message: string;
}

export interface WeekRow {
  weekLabel: string;
  sessions: number;
  turns: number;
  outputTokens: number;
  totalCostUsd: number | null;
}

export interface ThinkingTurnRow {
  uuid: string;
  sessionId: string;
  cwd: string | null;
  timestamp: number;
  outputTokens: number;
  costUsd: number | null;
  thinkingChars: number;
  textChars: number;
  message: string;
}

export interface ProjectMatch { cwd: string; }

export interface BashCommandRow {
  command: string;
  outputTokens: number;
  costUsd: number | null;
  uuid: string;
  timestamp: number;
  sessionId: string;
}

export interface RawTurnForTool {
  uuid: string;
  outputTokens: number;
  costUsd: number | null;
  message: string;
}

// ─── DB Path Resolution ───────────────────────────────────────────────────────

export function resolveDbPath(flagPath?: string): DbPathResult {
  if (flagPath) return { path: flagPath, source: "flag" };
  const envPath = process.env["TOKEN_SCOPE_DB"];
  if (envPath) return { path: envPath, source: "env" };
  const xdgConfig = process.env["XDG_CONFIG_HOME"];
  if (xdgConfig) {
    const xdgPath = join(xdgConfig, "claude", "__store.db");
    if (existsSync(xdgPath)) return { path: xdgPath, source: "xdg" };
  }
  const defaultPath = join(process.env["HOME"] ?? "~", ".claude", "__store.db");
  return { path: defaultPath, source: "default" };
}

// ─── DB Open ─────────────────────────────────────────────────────────────────

export function openDb(path: string): Database {
  if (!existsSync(path)) {
    process.stderr.write(`Database not found at "${path}". Set TOKEN_SCOPE_DB to override.\n`);
    process.exit(1);
  }
  try {
    return new Database(path, { readonly: true });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      process.stderr.write(`Database is locked ("${path}"). Wait for other processes to finish, then retry.\n`);
    } else if (msg.includes("SQLITE_CORRUPT") || msg.includes("malformed")) {
      process.stderr.write(`Database at "${path}" appears corrupted. Try pointing to a backup copy via TOKEN_SCOPE_DB.\n`);
    } else if (msg.includes("EACCES") || msg.includes("permission denied")) {
      process.stderr.write(`Cannot read "${path}": permission denied. Check file permissions or set TOKEN_SCOPE_DB.\n`);
    } else {
      process.stderr.write(`Failed to open database at "${path}": ${msg}\n`);
    }
    process.exit(1);
  }
}

// ─── Time Helpers ─────────────────────────────────────────────────────────────

export function parseSince(since: string): number {
  const now = Date.now();
  const match = /^(\d+)(h|d|w)$/.exec(since);
  if (!match) throw new Error(`Invalid --since format: "${since}". Use Nh, Nd, or Nw.`);
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return now - n * multipliers[unit]!;
}

// ─── Base join fragment — used by all time-scoped queries ─────────────────────

const JOIN = `
FROM assistant_messages am
JOIN base_messages bm ON am.uuid = bm.uuid
WHERE bm.timestamp > ?
  AND json_valid(am.message) = 1
`;

// ─── Summary Totals ───────────────────────────────────────────────────────────

export function querySummaryTotals(db: Database, since: number): SummaryTotals {
  const row = db.query<{
    totalOutputTokens: number; totalInputTokens: number;
    totalCacheReadTokens: number; totalCacheWriteTokens: number;
    totalCostUsd: number | null; sessionCount: number; turnCount: number;
  }, [number]>(`
    SELECT
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS totalOutputTokens,
      SUM(CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER)) AS totalInputTokens,
      SUM(CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) AS totalCacheReadTokens,
      SUM(CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER)) AS totalCacheWriteTokens,
      SUM(am.cost_usd) AS totalCostUsd,
      COUNT(DISTINCT bm.session_id) AS sessionCount,
      COUNT(*) AS turnCount
    ${JOIN}
  `).get(since);

  if (!row) return { totalOutputTokens: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostUsd: null, sessionCount: 0, turnCount: 0, avgCostPerSession: null, avgCostPerTurn: null };

  return {
    ...row,
    avgCostPerSession: row.totalCostUsd != null && row.sessionCount > 0 ? row.totalCostUsd / row.sessionCount : null,
    avgCostPerTurn: row.totalCostUsd != null && row.turnCount > 0 ? row.totalCostUsd / row.turnCount : null,
  };
}

// ─── Raw Turns (for dominant-tool grouping in JS) ─────────────────────────────

export function queryRawTurnsForTool(db: Database, since: number): RawTurnForTool[] {
  return db.query<RawTurnForTool, [number]>(`
    SELECT am.uuid,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      am.cost_usd AS costUsd, am.message
    ${JOIN}
  `).all(since);
}

// ─── By-Tool (dominant tool resolved in JS via parse.ts) ──────────────────────

export function queryByTool(db: Database, since: number, limit: number): ToolRow[] {
  const { parseContentBlocks, resolveDominantTool } = require("./parse") as typeof import("./parse");
  const turns = queryRawTurnsForTool(db, since);
  const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = turns.reduce((s, t) => s + (t.costUsd ?? 0), 0);

  const byTool = new Map<string, { turns: number; outputTokens: number; costUsd: number }>();
  for (const turn of turns) {
    const tool = resolveDominantTool(parseContentBlocks(turn.message));
    const e = byTool.get(tool) ?? { turns: 0, outputTokens: 0, costUsd: 0 };
    byTool.set(tool, { turns: e.turns + 1, outputTokens: e.outputTokens + turn.outputTokens, costUsd: e.costUsd + (turn.costUsd ?? 0) });
  }

  return Array.from(byTool.entries())
    .map(([tool, d]) => ({
      tool, turns: d.turns, outputTokens: d.outputTokens,
      outputPct: totalOutput > 0 ? (d.outputTokens / totalOutput) * 100 : 0,
      avgOutputPerTurn: d.turns > 0 ? d.outputTokens / d.turns : 0,
      totalCostUsd: d.costUsd > 0 ? d.costUsd : null,
      costPct: totalCost > 0 ? (d.costUsd / totalCost) * 100 : null,
    }))
    .sort((a, b) => b.outputTokens - a.outputTokens)
    .slice(0, limit);
}

// ─── By-Project ───────────────────────────────────────────────────────────────

export function queryByProject(db: Database, since: number, limit: number): ProjectRow[] {
  return db.query<ProjectRow, [number, number]>(`
    SELECT bm.cwd,
      COUNT(DISTINCT bm.session_id) AS sessions,
      COUNT(*) AS turns,
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS outputTokens,
      SUM(am.cost_usd) AS totalCostUsd,
      CASE WHEN COUNT(DISTINCT bm.session_id) > 0 THEN SUM(am.cost_usd) / COUNT(DISTINCT bm.session_id) ELSE NULL END AS avgSessionCost
    ${JOIN}
    GROUP BY bm.cwd ORDER BY totalCostUsd DESC NULLS LAST LIMIT ?
  `).all(since, limit);
}

// ─── Sessions List ────────────────────────────────────────────────────────────

export function querySessions(db: Database, since: number, limit: number): SessionRow[] {
  return db.query<SessionRow, [number, number]>(`
    SELECT bm.session_id AS sessionId, bm.cwd,
      MIN(bm.timestamp) AS startedAt,
      CASE WHEN COUNT(*) > 1 THEN MAX(bm.timestamp) - MIN(bm.timestamp) ELSE NULL END AS durationMs,
      COUNT(*) AS turnCount,
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS outputTokens,
      CASE WHEN SUM(CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) +
                   CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) > 0
           THEN CAST(SUM(CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) AS REAL) /
                SUM(CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) +
                    CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) * 100
           ELSE NULL END AS cacheHitPct,
      SUM(am.cost_usd) AS totalCostUsd
    ${JOIN}
    GROUP BY bm.session_id ORDER BY totalCostUsd DESC NULLS LAST LIMIT ?
  `).all(since, limit);
}

// ─── Session Turns ────────────────────────────────────────────────────────────

export function querySessionTurns(db: Database, sessionId: string): TurnRow[] {
  return db.query<TurnRow, [string]>(`
    SELECT am.uuid, bm.timestamp,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) AS inputTokens,
      CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER) AS cacheReadTokens,
      CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER) AS cacheWriteTokens,
      am.cost_usd AS costUsd, am.duration_ms AS durationMs, am.model,
      json_extract(am.message, '$.stop_reason') AS stopReason, am.message
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    WHERE bm.session_id = ? AND json_valid(am.message) = 1
    ORDER BY bm.timestamp ASC
  `).all(sessionId);
}

// ─── Weekly Trend ─────────────────────────────────────────────────────────────

export function queryWeeklyTrend(db: Database, since: number): WeekRow[] {
  return db.query<WeekRow, [number]>(`
    SELECT
      strftime('%Y-W%W', datetime(bm.timestamp / 1000, 'unixepoch')) AS weekLabel,
      COUNT(DISTINCT bm.session_id) AS sessions, COUNT(*) AS turns,
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS outputTokens,
      SUM(am.cost_usd) AS totalCostUsd
    ${JOIN}
    GROUP BY weekLabel ORDER BY weekLabel DESC LIMIT 5
  `).all(since);
}

// ─── Thinking Turns ───────────────────────────────────────────────────────────

export function queryThinkingTurns(db: Database, since: number): ThinkingTurnRow[] {
  return db.query<ThinkingTurnRow, [number]>(`
    SELECT am.uuid, bm.session_id AS sessionId, bm.cwd, bm.timestamp,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      am.cost_usd AS costUsd,
      SUM(CASE WHEN json_extract(block.value, '$.type') = 'thinking'
               THEN LENGTH(COALESCE(json_extract(block.value, '$.thinking'), '')) ELSE 0 END) AS thinkingChars,
      SUM(CASE WHEN json_extract(block.value, '$.type') = 'text'
               THEN LENGTH(COALESCE(json_extract(block.value, '$.text'), '')) ELSE 0 END) AS textChars,
      am.message
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    CROSS JOIN json_each(am.message, '$.content') AS block
    WHERE bm.timestamp > ? AND json_valid(am.message) = 1
    GROUP BY am.uuid HAVING thinkingChars > 0
  `).all(since);
}

// ─── Project Lookup ───────────────────────────────────────────────────────────

export function queryProjectMatches(db: Database, fragment: string): ProjectMatch[] {
  return db.query<ProjectMatch, [string]>(`
    SELECT DISTINCT bm.cwd FROM base_messages bm
    WHERE LOWER(bm.cwd) LIKE LOWER(?) AND bm.cwd IS NOT NULL ORDER BY bm.cwd
  `).all(`%${fragment}%`);
}

// ─── Bash Command Rows ────────────────────────────────────────────────────────

export function queryBashTurns(db: Database, since: number): BashCommandRow[] {
  return db.query<BashCommandRow, [number]>(`
    SELECT json_extract(block.value, '$.input.command') AS command,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      am.cost_usd AS costUsd, am.uuid, bm.timestamp, bm.session_id AS sessionId
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    CROSS JOIN json_each(am.message, '$.content') AS block
    WHERE bm.timestamp > ? AND json_valid(am.message) = 1
      AND json_extract(block.value, '$.type') = 'tool_use'
      AND json_extract(block.value, '$.name') = 'Bash'
  `).all(since);
}
```

- [ ] **Step 4: Run db tests**

```bash
bun test tests/db.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "Add db.ts with read-only SQL queries, path resolution, and integration tests"
```


---

## Task 6: `format.ts` — Terminal Formatting

**Files:**
- Create: `src/format.ts`

Covered by smoke tests in Task 13. No separate test file.

- [ ] **Step 1: Implement `src/format.ts`**

```typescript
// Respects NO_COLOR env var per https://no-color.org/
const USE_COLOR = !process.env["NO_COLOR"] && process.stdout.isTTY;

function ansi(code: string, text: string): string {
  if (!USE_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const bold  = (s: string) => ansi("1",  s);
export const dim   = (s: string) => ansi("2",  s);
export const cyan  = (s: string) => ansi("36", s);
export const green = (s: string) => ansi("32", s);

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function formatUsd(n: number | null | undefined, dp = 4): string {
  if (n == null) return "—";
  return `$${n.toFixed(dp)}`;
}

export function formatPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

export function formatTimestamp(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function approx(s: string): string {
  return s === "—" ? "—" : `~${s}`;
}

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

export interface Column {
  header: string;
  align?: "left" | "right";
  width?: number;
}

export function renderTable(columns: Column[], rows: string[][]): string {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const widths = columns.map((col, i) => {
    const contentMax = Math.max(0, ...rows.map((r) => stripAnsi(r[i] ?? "").length));
    return col.width ?? Math.max(stripAnsi(col.header).length, contentMax);
  });

  const pad = (s: string, w: number, align: "left" | "right" = "left") => {
    const visible = stripAnsi(s).length;
    const padding = Math.max(0, w - visible);
    return align === "right" ? " ".repeat(padding) + s : s + " ".repeat(padding);
  };

  const separator = widths.map((w) => "─".repeat(w)).join("─┼─");
  const header = widths.map((w, i) => pad(bold(columns[i]!.header), w + (USE_COLOR ? bold("").length : 0))).join(" │ ");
  const rowLines = rows.map((row) =>
    widths.map((w, i) => pad(row[i] ?? "", w, columns[i]?.align ?? "left")).join(" │ ")
  );

  return [header, separator, ...rowLines].join("\n");
}

export function renderKV(pairs: Array<[string, string]>, labelWidth = 28): string {
  return pairs.map(([label, value]) => `  ${dim(label.padEnd(labelWidth))} ${value}`).join("\n");
}

export function renderHeader(title: string): string {
  const line = "─".repeat(60);
  return `\n${line}\n${bold(title)}\n${line}`;
}

export function renderFootnote(text: string): string {
  return `\n${dim(`  * ${text}`)}`;
}

export function renderFooter(text: string): string {
  return `\n${dim(text)}`;
}
```

- [ ] **Step 2: Typecheck**

```bash
bun tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/format.ts
git commit -m "Add format.ts terminal table builder, ANSI helpers, and number formatters"
```


---

## Task 7: `cli.ts` — Argument Parsing and Routing

**Files:**
- Create: `src/cli.ts`

Entry point only. Parses flags, validates mutual exclusions, resolves DB path, routes to report modules.

- [ ] **Step 1: Implement `src/cli.ts`**

```typescript
import { resolveDbPath, openDb, parseSince } from "@/db";

const VERSION = "1.0.0";

const HELP = `
token-scope — Claude Code output token analytics

USAGE
  token-scope [flags]

REPORT MODES (mutually exclusive)
  (default)               Summary: totals, by-tool, by-project, weekly trend
  --tool <name>           Drill into a specific tool (bash, read, edit, agent, ...)
  --project <fragment>    Filter to sessions whose cwd contains <fragment>
  --session <id>          Turn-by-turn breakdown of one session (min 6-char prefix)
  --thinking              Thinking token analysis
  --sessions              List recent sessions with stats

SHARED FLAGS
  --since <duration>      Time window: Nh hours, Nd days, Nw weeks (default: 30d)
  --limit <n>             Cap rows in tables (default: 20)
  --json                  Machine-readable JSON output
  --db <path>             Override database path (overrides TOKEN_SCOPE_DB)
  --version               Print version and exit
  --help                  Show this help
`.trim();

interface CliArgs {
  mode: "summary" | "tool" | "project" | "session" | "thinking" | "sessions";
  toolName?: string;
  projectFragment?: string;
  sessionId?: string;
  since: string;
  limit: number;
  json: boolean;
  dbPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "summary", since: "30d", limit: 20, json: false };
  let modeSet = false;

  const setMode = (mode: CliArgs["mode"]) => {
    if (modeSet) {
      process.stderr.write("Error: --tool, --project, --session, --thinking, and --sessions are mutually exclusive.\n");
      process.exit(1);
    }
    args.mode = mode;
    modeSet = true;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help": case "-h": console.log(HELP); process.exit(0); break;
      case "--version": case "-v": console.log(`token-scope ${VERSION}`); process.exit(0); break;
      case "--json": args.json = true; break;
      case "--thinking": setMode("thinking"); break;
      case "--sessions": setMode("sessions"); break;
      case "--tool":
        setMode("tool");
        args.toolName = argv[++i];
        if (!args.toolName) { process.stderr.write("Error: --tool requires a name argument.\n"); process.exit(1); }
        break;
      case "--project":
        setMode("project");
        args.projectFragment = argv[++i];
        if (!args.projectFragment) { process.stderr.write("Error: --project requires a fragment argument.\n"); process.exit(1); }
        break;
      case "--session":
        setMode("session");
        args.sessionId = argv[++i];
        if (!args.sessionId) { process.stderr.write("Error: --session requires a session ID argument.\n"); process.exit(1); }
        if (args.sessionId.length < 6) { process.stderr.write("Error: --session ID must be at least 6 characters.\n"); process.exit(1); }
        break;
      case "--since":
        args.since = argv[++i] ?? "30d";
        if (!/^\d+(h|d|w)$/.test(args.since)) {
          process.stderr.write(`Error: Invalid --since format "${args.since}". Use Nh, Nd, or Nw.\n`);
          process.exit(1);
        }
        break;
      case "--limit": {
        const val = argv[++i];
        const n = parseInt(val ?? "", 10);
        if (isNaN(n) || n < 1) { process.stderr.write("Error: --limit must be a positive integer.\n"); process.exit(1); }
        args.limit = n;
        break;
      }
      case "--db":
        args.dbPath = argv[++i];
        if (!args.dbPath) { process.stderr.write("Error: --db requires a path argument.\n"); process.exit(1); }
        break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`Error: Unknown flag "${arg}". Run token-scope --help for usage.\n`);
          process.exit(1);
        }
    }
  }

  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const { path: dbPath } = resolveDbPath(args.dbPath);
  const db = openDb(dbPath);

  let since: number;
  try {
    since = parseSince(args.since);
  } catch (e) {
    process.stderr.write(`${String(e)}\n`);
    process.exit(1);
  }

  if (args.mode === "session") {
    const { renderSessionView } = await import("@/reports/session");
    await renderSessionView(db, args.sessionId!, args.json, args.since);
    db.close();
    return;
  }

  const options = { since, limit: args.limit, json: args.json };

  switch (args.mode) {
    case "summary": {
      const { renderSummary } = await import("@/reports/summary");
      renderSummary(db, options); break;
    }
    case "tool": {
      const { renderToolDrillDown } = await import("@/reports/tool");
      renderToolDrillDown(db, args.toolName!, options); break;
    }
    case "project": {
      const { renderProjectDrillDown } = await import("@/reports/project");
      renderProjectDrillDown(db, args.projectFragment!, options); break;
    }
    case "sessions": {
      const { renderSessionsList } = await import("@/reports/session");
      renderSessionsList(db, options); break;
    }
    case "thinking": {
      const { renderThinkingReport } = await import("@/reports/thinking");
      renderThinkingReport(db, options); break;
    }
  }

  db.close();
}

main().catch((e) => {
  process.stderr.write(`Unexpected error: ${String(e)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Test mutual exclusion**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --tool bash --project foo 2>&1
```

Expected: `Error: --tool, --project, --session, --thinking, and --sessions are mutually exclusive.` Exit code 1.

- [ ] **Step 3: Test unknown flag**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --unknown-flag 2>&1
```

Expected: `Error: Unknown flag "--unknown-flag".` Exit code 1.

- [ ] **Step 4: Test --version**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --version
```

Expected: `token-scope 1.0.0`

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "Add cli.ts entry point with argv parsing and mutual exclusion validation"
```


---

## Task 8: `reports/summary.ts`

**Files:**
- Create: `src/reports/summary.ts`

- [ ] **Step 1: Implement `src/reports/summary.ts`**

```typescript
import type { Database } from "bun:sqlite";
import { querySummaryTotals, queryByTool, queryByProject, queryWeeklyTrend } from "@/db";
import { renderHeader, renderKV, renderTable, renderFootnote, renderFooter, formatTokens, formatUsd, formatPct, bold, dim } from "@/format";

interface Options { since: number; limit: number; json: boolean }

export function renderSummary(db: Database, opts: Options): void {
  const totals = querySummaryTotals(db, opts.since);
  const byTool = queryByTool(db, opts.since, opts.limit);
  const byProject = queryByProject(db, opts.since, opts.limit);
  const weekly = queryWeeklyTrend(db, opts.since);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "summary", totals, byTool, byProject, weeklyTrend: weekly,
    }, null, 2));
    return;
  }

  const sinceDate = new Date(opts.since).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  console.log(renderHeader(`token-scope — Summary  (${sinceDate} → now)`));
  console.log(`  Sessions: ${bold(String(totals.sessionCount))}   Turns: ${bold(String(totals.turnCount))}\n`);

  console.log(bold("  Totals"));
  console.log(renderKV([
    ["Output Tokens", formatTokens(totals.totalOutputTokens)],
    ["Input Tokens", formatTokens(totals.totalInputTokens)],
    ["Cache Read Tokens", formatTokens(totals.totalCacheReadTokens)],
    ["Cache Write Tokens", formatTokens(totals.totalCacheWriteTokens)],
    ["Total Cost", formatUsd(totals.totalCostUsd)],
    ["Avg Cost / Session", formatUsd(totals.avgCostPerSession)],
    ["Avg Cost / Turn", formatUsd(totals.avgCostPerTurn)],
  ]));

  const cacheHitRate = totals.totalInputTokens + totals.totalCacheReadTokens > 0
    ? (totals.totalCacheReadTokens / (totals.totalInputTokens + totals.totalCacheReadTokens)) * 100
    : null;

  console.log(`\n${bold("  Cache Efficiency")}`);
  console.log(renderKV([
    ["Cache Hit Rate", formatPct(cacheHitRate)],
    ["Est. Cache Savings", "— (requires model breakdown)"],
  ]));

  console.log(`\n${bold("  Output Tokens by Tool")}`);
  console.log(renderTable(
    [
      { header: "Tool", align: "left" },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Output %", align: "right", width: 9 },
      { header: "Avg/Turn", align: "right", width: 10 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "Cost %", align: "right", width: 7 },
    ],
    byTool.map((r) => [r.tool, String(r.turns), formatTokens(r.outputTokens), formatPct(r.outputPct), formatTokens(r.avgOutputPerTurn), formatUsd(r.totalCostUsd), formatPct(r.costPct)])
  ));
  console.log(renderFootnote("Each turn attributed to its dominant tool by input character size. Output tokens are turn-level totals."));

  console.log(`\n${bold("  Output Tokens by Project")}`);
  console.log(renderTable(
    [
      { header: "Project", align: "left" },
      { header: "Sessions", align: "right", width: 9 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "Avg Session Cost", align: "right", width: 17 },
    ],
    byProject.map((r) => [r.cwd ?? "(unknown)", String(r.sessions), String(r.turns), formatTokens(r.outputTokens), formatUsd(r.totalCostUsd), formatUsd(r.avgSessionCost)])
  ));

  if (weekly.length > 0) {
    console.log(`\n${bold("  Weekly Trend")}`);
    console.log(renderTable(
      [
        { header: "Week", align: "left", width: 10 },
        { header: "Sessions", align: "right", width: 9 },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Total Cost", align: "right", width: 11 },
      ],
      weekly.map((r) => [r.weekLabel, String(r.sessions), String(r.turns), formatTokens(r.outputTokens), formatUsd(r.totalCostUsd, 2)])
    ));
  }

  console.log("");
}
```

- [ ] **Step 2: Smoke test**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts
```

Expected: summary with By-Tool table (Agent, Read, Bash, Grep, text-only rows), By-Project (3 projects with since=0; 2 with default 30d), Weekly Trend.

- [ ] **Step 3: Commit**

```bash
git add src/reports/summary.ts
git commit -m "Add summary report with totals, by-tool, by-project, and weekly trend panels"
```

---

## Task 9: `reports/tool.ts`

**Files:**
- Create: `src/reports/tool.ts`

- [ ] **Step 1: Implement `src/reports/tool.ts`**

```typescript
import type { Database } from "bun:sqlite";
import { queryRawTurnsForTool, queryBashTurns, querySummaryTotals } from "@/db";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, formatTimestamp, truncate, bold } from "@/format";
import { parseContentBlocks, resolveDominantTool, categorizeBashCommand } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderToolDrillDown(db: Database, toolName: string, opts: Options): void {
  const normalizedName = toolName.charAt(0).toUpperCase() + toolName.slice(1).toLowerCase();
  const allTurns = queryRawTurnsForTool(db, opts.since);
  const allTotals = querySummaryTotals(db, opts.since);

  const toolTurns = allTurns.filter((t) => resolveDominantTool(parseContentBlocks(t.message)).toLowerCase() === toolName.toLowerCase());

  if (toolTurns.length === 0) {
    console.log(`No turns found for tool "${normalizedName}" in the last ${opts.since}.`);
    return;
  }

  const totalOutput = toolTurns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = toolTurns.reduce((s, t) => s + (t.costUsd ?? 0), 0);
  const sorted = [...toolTurns].sort((a, b) => a.outputTokens - b.outputTokens);
  const p50 = sorted[Math.floor(sorted.length * 0.5)]?.outputTokens ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]?.outputTokens ?? 0;
  const shareOutput = allTotals.totalOutputTokens > 0 ? (totalOutput / allTotals.totalOutputTokens) * 100 : 0;
  const shareCost = (allTotals.totalCostUsd ?? 0) > 0 ? (totalCost / (allTotals.totalCostUsd ?? 1)) * 100 : 0;

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "tool", toolName: normalizedName,
      overview: { turns: toolTurns.length, totalOutputTokens: totalOutput, totalCostUsd: totalCost, shareOutputPct: shareOutput, shareCostPct: shareCost },
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Tool: ${bold(normalizedName)}`));
  console.log(renderKV([
    ["Turns (dominant)", String(toolTurns.length)],
    ["Total Output Tokens", formatTokens(totalOutput)],
    ["Total Cost", formatUsd(totalCost)],
    ["Share of All Output", formatPct(shareOutput)],
    ["Share of All Cost", formatPct(shareCost)],
    ["Avg Output / Turn", formatTokens(totalOutput / toolTurns.length)],
    ["Distribution (p50/p95/max)", `${formatTokens(p50)} / ${formatTokens(p95)} / ${formatTokens(sorted.at(-1)?.outputTokens)}`],
  ]));

  if (toolName.toLowerCase() === "bash") {
    const bashTurns = queryBashTurns(db, opts.since);
    const categories = new Map<string, { turns: number; outputTokens: number; costUsd: number }>();
    for (const t of bashTurns) {
      const cat = categorizeBashCommand(t.command ?? "");
      const e = categories.get(cat) ?? { turns: 0, outputTokens: 0, costUsd: 0 };
      categories.set(cat, { turns: e.turns + 1, outputTokens: e.outputTokens + t.outputTokens, costUsd: e.costUsd + (t.costUsd ?? 0) });
    }

    const catRows = Array.from(categories.entries())
      .sort((a, b) => b[1].outputTokens - a[1].outputTokens)
      .map(([cat, d]) => [cat, String(d.turns), formatTokens(d.outputTokens), formatTokens(d.outputTokens / d.turns), formatUsd(d.costUsd)]);

    console.log(`\n${bold("  Command Categories")}`);
    console.log(renderTable(
      [
        { header: "Category", align: "left" },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Avg/Turn", align: "right", width: 10 },
        { header: "Total Cost", align: "right", width: 11 },
      ],
      catRows
    ));

    const topCommands = [...bashTurns].sort((a, b) => b.outputTokens - a.outputTokens).slice(0, opts.limit);
    console.log(`\n${bold("  Most Expensive Commands")}`);
    console.log(renderTable(
      [
        { header: "Command", align: "left", width: 60 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      topCommands.map((t) => [truncate(t.command ?? "(none)", 60), formatTokens(t.outputTokens), formatUsd(t.costUsd)])
    ));
  }

  console.log("");
}
```

- [ ] **Step 2: Smoke tests**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --tool bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --tool read
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --tool nonexistent
```

Expected: bash shows categories + top commands. Read shows overview only. Nonexistent prints "No turns found..." without error.

- [ ] **Step 3: Commit**

```bash
git add src/reports/tool.ts
git commit -m "Add tool drill-down report with Bash command category breakdown"
```

---

## Task 10: `reports/project.ts`

**Files:**
- Create: `src/reports/project.ts`

- [ ] **Step 1: Implement `src/reports/project.ts`**

```typescript
import type { Database } from "bun:sqlite";
import { queryProjectMatches, queryByProject, querySessions } from "@/db";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatTimestamp, truncate, bold, dim } from "@/format";

interface Options { since: number; limit: number; json: boolean }

export function renderProjectDrillDown(db: Database, fragment: string, opts: Options): void {
  const matches = queryProjectMatches(db, fragment);

  if (matches.length === 0) {
    console.log(`No projects found matching "${fragment}".`);
    return;
  }

  if (matches.length > 1) {
    console.log(`Multiple projects match "${fragment}":`);
    matches.forEach((m, i) => console.log(`  ${i + 1}. ${m.cwd}`));
    console.log("Re-run with a more specific fragment.");
    return;
  }

  const cwd = matches[0]!.cwd;
  const allProjects = queryByProject(db, opts.since, 1000);
  const project = allProjects.find((p) => p.cwd === cwd);

  if (!project) {
    console.log(`No data for project "${cwd}" in the last ${opts.since}.`);
    return;
  }

  const sessions = querySessions(db, opts.since, opts.limit).filter((s) => s.cwd === cwd);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "project", cwd, project, sessions,
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Project: ${cwd}`));
  console.log(renderKV([
    ["Sessions", String(project.sessions)],
    ["Turns", String(project.turns)],
    ["Output Tokens", formatTokens(project.outputTokens)],
    ["Total Cost", formatUsd(project.totalCostUsd)],
    ["Avg Session Cost", formatUsd(project.avgSessionCost)],
  ]));

  if (sessions.length > 0) {
    console.log(`\n${bold("  Recent Sessions")}`);
    console.log(renderTable(
      [
        { header: "Session ID", align: "left", width: 12 },
        { header: "Started", align: "left", width: 18 },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      sessions.map((s) => [s.sessionId.slice(0, 12), formatTimestamp(s.startedAt), String(s.turnCount), formatTokens(s.outputTokens), formatUsd(s.totalCostUsd)])
    ));
  }

  console.log("");
}
```

- [ ] **Step 2: Smoke tests**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --project token-scope
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --project alice
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --project projects
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --project zzz-no-match
```

Expected: `token-scope` shows single project. `alice` hits disambiguation (3 matches). `projects` also disambiguation. `zzz-no-match` shows "No projects found".

- [ ] **Step 3: Commit**

```bash
git add src/reports/project.ts
git commit -m "Add project drill-down report with multi-match disambiguation"
```

---

## Task 11: `reports/session.ts`

**Files:**
- Create: `src/reports/session.ts`

Handles both `--session <id>` (turn-by-turn view) and `--sessions` (list).

- [ ] **Step 1: Implement `src/reports/session.ts`**

```typescript
import type { Database } from "bun:sqlite";
import { querySessionTurns, querySessions } from "@/db";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, formatDuration, formatTimestamp, approx, truncate, bold, dim } from "@/format";
import { parseContentBlocks, resolveDominantTool, estimateThinkingTokens } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderSessionView(db: Database, sessionId: string, json: boolean, sinceStr: string): void {
  const allSessions = querySessions(db, 0, 10000);
  const matching = allSessions.filter((s) => s.sessionId.startsWith(sessionId));

  if (matching.length === 0) {
    console.log(`No session found with ID starting with "${sessionId}".`);
    return;
  }
  if (matching.length > 1) {
    console.log(`Multiple sessions match "${sessionId}":`);
    matching.forEach((s) => console.log(`  ${s.sessionId.slice(0, 16)} — ${s.cwd ?? "(unknown)"}`));
    console.log("Use a longer prefix.");
    return;
  }

  const session = matching[0]!;
  const turns = querySessionTurns(db, session.sessionId);

  if (turns.length === 0) {
    console.log(`Session "${sessionId}" has no valid turns.`);
    return;
  }

  const peakIdx = turns.reduce((max, t, i) => t.outputTokens > (turns[max]?.outputTokens ?? 0) ? i : max, 0);

  if (json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), token_scope_version: "1.0.0" },
      report: "session", session,
      turns: turns.map((t, i) => {
        const blocks = parseContentBlocks(t.message);
        const { thinking, text } = getThinkingChars(blocks);
        return {
          turn: i + 1, timestamp: t.timestamp,
          dominantTool: resolveDominantTool(blocks),
          outputTokens: t.outputTokens, costUsd: t.costUsd, stopReason: t.stopReason,
          estimatedThinkingTokens: estimateThinkingTokens(thinking, text, t.outputTokens),
        };
      }),
    }, null, 2));
    return;
  }

  if (sinceStr !== "30d") {
    console.log(dim("  Note: --since is ignored for --session (a session is a fixed time range)."));
  }

  const startMs = turns[0]!.timestamp;
  const endMs = turns.at(-1)!.timestamp;

  console.log(renderHeader(`token-scope — Session: ${session.sessionId.slice(0, 16)}…`));
  console.log(renderKV([
    ["Project", session.cwd ?? "(unknown)"],
    ["Started", formatTimestamp(startMs)],
    ["Duration", formatDuration(endMs - startMs)],
    ["Turns", String(turns.length)],
    ["Total Output Tokens", formatTokens(session.outputTokens)],
    ["Total Cost", formatUsd(session.totalCostUsd)],
    ["Peak Turn", `Turn ${peakIdx + 1} (${formatTokens(turns[peakIdx]!.outputTokens)} tokens)`],
  ]));

  let cumulativeTokens = 0;
  let cumulativeCost = 0;

  const rows = turns.map((t, i) => {
    const blocks = parseContentBlocks(t.message);
    const { thinking, text } = getThinkingChars(blocks);
    const thinkingPct = thinking + text > 0 ? approx(formatPct((thinking / (thinking + text)) * 100)) : "—";
    cumulativeTokens += t.outputTokens;
    cumulativeCost += t.costUsd ?? 0;
    const row = [
      String(i + 1), formatTimestamp(t.timestamp), resolveDominantTool(blocks),
      thinkingPct, formatTokens(t.outputTokens), formatTokens(cumulativeTokens),
      formatUsd(t.costUsd), formatUsd(cumulativeCost), t.stopReason ?? "—",
    ];
    return i === peakIdx ? row.map(bold) : row;
  });

  console.log(`\n${bold("  Turn-by-Turn Breakdown")}`);
  console.log(renderTable(
    [
      { header: "#", align: "right", width: 4 },
      { header: "Timestamp", align: "left", width: 14 },
      { header: "Dominant Tool", align: "left", width: 16 },
      { header: "~Think Chars %", align: "right", width: 15 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Cumulative", align: "right", width: 12 },
      { header: "Cost", align: "right", width: 10 },
      { header: "Cumul. Cost", align: "right", width: 12 },
      { header: "Stop", align: "left", width: 10 },
    ],
    rows
  ));
  console.log(renderFootnote("~Think Chars % is a character ratio, not a token ratio (±15–30% error)."));
  console.log(renderFootnote("Peak turn (most output tokens) is shown in bold."));
  console.log("");
}

export function renderSessionsList(db: Database, opts: Options): void {
  const sessions = querySessions(db, opts.since, opts.limit);

  if (opts.json) {
    const total = sessions.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "sessions",
      totals: { session_count: sessions.length, total_cost_usd: total, avg_session_cost_usd: sessions.length > 0 ? total / sessions.length : 0 },
      sessions: sessions.map((s) => ({
        session_id: s.sessionId, cwd: s.cwd, started_at: new Date(s.startedAt).toISOString(),
        duration_ms: s.durationMs, turn_count: s.turnCount, output_tokens: s.outputTokens,
        cache_hit_pct: s.cacheHitPct, total_cost_usd: s.totalCostUsd,
      })),
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Sessions  (last ${opts.since})`));
  console.log(renderTable(
    [
      { header: "Session ID", align: "left", width: 14 },
      { header: "Project", align: "left", width: 40 },
      { header: "Started", align: "left", width: 16 },
      { header: "Duration", align: "right", width: 10 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Cache Hit%", align: "right", width: 10 },
      { header: "Cost", align: "right", width: 10 },
    ],
    sessions.map((s) => [
      s.sessionId.slice(0, 14), truncate(s.cwd ?? "(unknown)", 40), formatTimestamp(s.startedAt),
      formatDuration(s.durationMs), String(s.turnCount), formatTokens(s.outputTokens),
      formatPct(s.cacheHitPct), formatUsd(s.totalCostUsd),
    ])
  ));

  const totalCost = sessions.reduce((sum, s) => sum + (s.totalCostUsd ?? 0), 0);
  const avgCost = sessions.length > 0 ? totalCost / sessions.length : 0;
  console.log(dim(`\n  Showing ${sessions.length} sessions  |  Total cost: ${formatUsd(totalCost)}  |  Avg: ${formatUsd(avgCost)}`));
  console.log("");
}

function getThinkingChars(blocks: ReturnType<typeof parseContentBlocks>) {
  let thinking = 0, text = 0;
  for (const b of blocks) {
    if (b.type === "thinking") thinking += (b.thinking ?? "").length;
    else if (b.type === "text") text += (b.text ?? "").length;
  }
  return { thinking, text };
}
```

- [ ] **Step 2: Smoke tests**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --session sess-a1
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --sessions
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --session sess-a1 --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['turns']), 'turns')"
```

Expected: session view shows 3 turns with turn 3 (1528 tokens) as peak (bold). Sessions list shows all sessions sorted by cost. JSON has 3 turns.

- [ ] **Step 3: Commit**

```bash
git add src/reports/session.ts
git commit -m "Add session view (turn-by-turn) and sessions list report"
```

---

## Task 12: `reports/thinking.ts`

**Files:**
- Create: `src/reports/thinking.ts`

- [ ] **Step 1: Implement `src/reports/thinking.ts`**

```typescript
import type { Database } from "bun:sqlite";
import { queryThinkingTurns, querySummaryTotals, querySessions } from "@/db";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, formatTimestamp, approx, bold, dim } from "@/format";
import { estimateThinkingTokens, parseContentBlocks, resolveDominantTool } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderThinkingReport(db: Database, opts: Options): void {
  const thinkingTurns = queryThinkingTurns(db, opts.since);
  const totals = querySummaryTotals(db, opts.since);
  const allSessions = querySessions(db, opts.since, 10000);

  const sessionIdsWithThinking = new Set(thinkingTurns.map((t) => t.sessionId));
  const sessionsWithThinking = allSessions.filter((s) => sessionIdsWithThinking.has(s.sessionId));
  const sessionsWithout = allSessions.filter((s) => !sessionIdsWithThinking.has(s.sessionId));

  let totalEstThinking = 0;
  let totalThinkingChars = 0;
  let totalTextChars = 0;

  const enriched = thinkingTurns.map((t) => {
    const est = estimateThinkingTokens(t.thinkingChars, t.textChars, t.outputTokens) ?? 0;
    totalEstThinking += est;
    totalThinkingChars += t.thinkingChars;
    totalTextChars += t.textChars;
    return { ...t, estimatedThinkingTokens: est, dominantTool: resolveDominantTool(parseContentBlocks(t.message)) };
  });

  const thinkingPctOfOutput = totals.totalOutputTokens > 0 ? (totalEstThinking / totals.totalOutputTokens) * 100 : 0;

  const byTool = new Map<string, { turns: number; estThinking: number }>();
  for (const t of enriched) {
    const e = byTool.get(t.dominantTool) ?? { turns: 0, estThinking: 0 };
    byTool.set(t.dominantTool, { turns: e.turns + 1, estThinking: e.estThinking + t.estimatedThinkingTokens });
  }

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "thinking",
      overview: {
        estimated_thinking_tokens: totalEstThinking,
        thinking_pct_of_output: thinkingPctOfOutput,
        turns_with_thinking: thinkingTurns.length,
        turns_with_thinking_pct: totals.turnCount > 0 ? (thinkingTurns.length / totals.turnCount) * 100 : 0,
        sessions_with_thinking: sessionsWithThinking.length,
      },
      character_distribution: {
        thinking_chars: totalThinkingChars, text_chars: totalTextChars,
        thinking_char_pct: totalThinkingChars + totalTextChars > 0 ? (totalThinkingChars / (totalThinkingChars + totalTextChars)) * 100 : 0,
        estimated_thinking_tokens: totalEstThinking,
      },
    }, null, 2));
    return;
  }

  console.log(renderHeader("token-scope — Thinking Analysis"));
  console.log(renderKV([
    ["~Total Thinking Tokens (est)", approx(formatTokens(totalEstThinking))],
    ["~Thinking % of Output", approx(formatPct(thinkingPctOfOutput))],
    ["Turns with Thinking", `${thinkingTurns.length} (${formatPct(totals.turnCount > 0 ? thinkingTurns.length / totals.turnCount * 100 : 0)} of all turns)`],
    ["Sessions with Thinking", `${sessionsWithThinking.length} (${formatPct(allSessions.length > 0 ? sessionsWithThinking.length / allSessions.length * 100 : 0)})`],
  ]));
  console.log(renderFootnote("Thinking token counts are character-ratio estimates (±15–30% error). Prefixed with ~ throughout."));

  const totalChars = totalThinkingChars + totalTextChars;
  if (totalChars > 0) {
    console.log(`\n${bold("  Content Character Distribution")} ${dim("(character proxy, not a token split)")}`);
    console.log(renderTable(
      [
        { header: "Content Block Type", align: "left", width: 20 },
        { header: "Total Characters", align: "right", width: 18 },
        { header: "Char %", align: "right", width: 8 },
        { header: "~Token Estimate", align: "right", width: 16 },
      ],
      [
        ["thinking", formatTokens(totalThinkingChars), formatPct(totalThinkingChars / totalChars * 100), approx(formatTokens(totalEstThinking))],
        ["text", formatTokens(totalTextChars), formatPct(totalTextChars / totalChars * 100), approx(formatTokens(totals.totalOutputTokens - totalEstThinking))],
      ]
    ));
    console.log(renderFootnote("tool_use block JSON contributes to output_tokens but is excluded from this panel."));
  }

  const toolRows = Array.from(byTool.entries()).sort((a, b) => b[1].estThinking - a[1].estThinking).slice(0, opts.limit);
  if (toolRows.length > 0) {
    console.log(`\n${bold("  By Co-occurring Tool")}`);
    console.log(renderTable(
      [
        { header: "Co-occurring Tool", align: "left", width: 20 },
        { header: "Thinking Turns", align: "right", width: 15 },
        { header: "~Avg Thinking Tokens", align: "right", width: 21 },
        { header: "~Total Thinking Tokens", align: "right", width: 22 },
      ],
      toolRows.map(([tool, d]) => [tool, String(d.turns), approx(formatTokens(d.estThinking / d.turns)), approx(formatTokens(d.estThinking))])
    ));
  }

  const avgOutput = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + r.outputTokens, 0) / ss.length : 0;
  const avgCost = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0) / ss.length : 0;
  const avgTurns = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + r.turnCount, 0) / ss.length : 0;

  console.log(`\n${bold("  Session Comparison")}`);
  console.log(renderTable(
    [
      { header: "Metric", align: "left", width: 22 },
      { header: "Thinking Sessions", align: "right", width: 19 },
      { header: "Non-Thinking Sessions", align: "right", width: 22 },
    ],
    [
      ["Count", String(sessionsWithThinking.length), String(sessionsWithout.length)],
      ["Avg Output Tokens", formatTokens(avgOutput(sessionsWithThinking)), formatTokens(avgOutput(sessionsWithout))],
      ["Avg Cost", formatUsd(avgCost(sessionsWithThinking)), formatUsd(avgCost(sessionsWithout))],
      ["Avg Turns", String(Math.round(avgTurns(sessionsWithThinking))), String(Math.round(avgTurns(sessionsWithout)))],
    ]
  ));

  const top10 = [...enriched].sort((a, b) => b.estimatedThinkingTokens - a.estimatedThinkingTokens).slice(0, 10);
  if (top10.length > 0) {
    console.log(`\n${bold("  Top Thinking Turns")}`);
    console.log(renderTable(
      [
        { header: "Session", align: "left", width: 12 },
        { header: "Project", align: "left", width: 25 },
        { header: "Timestamp", align: "left", width: 16 },
        { header: "~Thinking Tokens", align: "right", width: 17 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      top10.map((t) => [
        t.sessionId.slice(0, 12), (t.cwd ?? "(unknown)").split("/").at(-1) ?? "(unknown)",
        formatTimestamp(t.timestamp), approx(formatTokens(t.estimatedThinkingTokens)),
        formatTokens(t.outputTokens), formatUsd(t.costUsd),
      ])
    ));
  }

  console.log("");
}
```

- [ ] **Step 2: Smoke test**

```bash
TOKEN_SCOPE_DB=tests/fixtures/__store.db bun run src/cli.ts --thinking
```

Expected: overview (1 thinking turn from sess-a1 turn 2), character distribution, co-occurring tool (Read), session comparison, top thinking turns table.

- [ ] **Step 3: Commit**

```bash
git add src/reports/thinking.ts
git commit -m "Add thinking analysis report with character distribution and session comparison"
```


---

## Task 13: Smoke Tests (`reports.test.ts`)

**Files:**
- Create: `tests/reports.test.ts`

Verifies all reports render without throwing and `--json` output is valid schema-conforming JSON.

- [ ] **Step 1: Write smoke tests**

Create `tests/reports.test.ts`:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { openDb, resolveDbPath } from "@/db";
import type { Database } from "bun:sqlite";
import { renderSummary } from "@/reports/summary";
import { renderToolDrillDown } from "@/reports/tool";
import { renderProjectDrillDown } from "@/reports/project";
import { renderSessionView, renderSessionsList } from "@/reports/session";
import { renderThinkingReport } from "@/reports/thinking";

let db: Database;
const opts = { since: 0, limit: 20, json: false };

beforeAll(() => { db = openDb(resolveDbPath().path); });
afterAll(() => { db.close(); });

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  try { fn(); } finally { process.stdout.write = orig; }
  return lines.join("");
}

describe("Summary report", () => {
  it("renders without throwing", () => {
    expect(() => renderSummary(db, opts)).not.toThrow();
  });

  it("renders valid JSON with report=summary and required keys", () => {
    const output = capture(() => renderSummary(db, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("summary");
    expect(parsed.meta).toHaveProperty("generated_at");
    expect(parsed).toHaveProperty("totals");
    expect(parsed).toHaveProperty("byTool");
    expect(Array.isArray(parsed.byTool)).toBe(true);
  });
});

describe("Tool report", () => {
  it("renders bash without throwing", () => {
    expect(() => renderToolDrillDown(db, "bash", opts)).not.toThrow();
  });

  it("renders non-bash tool without throwing", () => {
    expect(() => renderToolDrillDown(db, "read", opts)).not.toThrow();
  });

  it("renders valid JSON for bash with toolName field", () => {
    const output = capture(() => renderToolDrillDown(db, "bash", { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("tool");
    expect(parsed.toolName).toBe("Bash");
  });

  it("handles unknown tool gracefully without throwing", () => {
    expect(() => renderToolDrillDown(db, "nonexistent-tool-xyz", opts)).not.toThrow();
  });
});

describe("Project report", () => {
  it("renders single-match project without throwing", () => {
    expect(() => renderProjectDrillDown(db, "token-scope", opts)).not.toThrow();
  });

  it("prints disambiguation for multi-match without throwing", () => {
    expect(() => renderProjectDrillDown(db, "projects", opts)).not.toThrow();
    const output = capture(() => renderProjectDrillDown(db, "projects", opts));
    expect(output).toContain("Multiple projects match");
  });

  it("handles no-match gracefully without throwing", () => {
    expect(() => renderProjectDrillDown(db, "zzz-nonexistent-xyz", opts)).not.toThrow();
  });
});

describe("Session view", () => {
  it("renders sess-a1 without throwing", () => {
    expect(() => renderSessionView(db, "sess-a1", false, "30d")).not.toThrow();
  });

  it("renders valid JSON with 3 turns for sess-a1", () => {
    const output = capture(() => renderSessionView(db, "sess-a1", true, "30d"));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("session");
    expect(Array.isArray(parsed.turns)).toBe(true);
    expect(parsed.turns.length).toBe(3);
  });

  it("handles unknown session gracefully without throwing", () => {
    expect(() => renderSessionView(db, "unknown-session-id", false, "30d")).not.toThrow();
  });
});

describe("Sessions list", () => {
  it("renders without throwing", () => {
    expect(() => renderSessionsList(db, opts)).not.toThrow();
  });

  it("renders valid JSON with sessions array and totals", () => {
    const output = capture(() => renderSessionsList(db, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("sessions");
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.totals).toHaveProperty("session_count");
    expect(parsed.totals).toHaveProperty("total_cost_usd");
  });
});

describe("Thinking report", () => {
  it("renders without throwing", () => {
    expect(() => renderThinkingReport(db, opts)).not.toThrow();
  });

  it("renders valid JSON with overview.estimated_thinking_tokens", () => {
    const output = capture(() => renderThinkingReport(db, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("thinking");
    expect(parsed.overview).toHaveProperty("estimated_thinking_tokens");
    expect(parsed.overview).toHaveProperty("turns_with_thinking");
  });
});
```

- [ ] **Step 2: Run smoke tests**

```bash
bun test tests/reports.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run full suite**

```bash
bun test
```

Expected: parse.test.ts + db.test.ts + reports.test.ts all green. Target: 50+ pass, 0 fail.

- [ ] **Step 4: Final typecheck**

```bash
bun tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add tests/reports.test.ts
git commit -m "Add smoke tests for all report modes; full test suite green"
```

---

## Task 14: `skill/SKILL.md`

**Files:**
- Create: `skill/SKILL.md`

- [ ] **Step 1: Create `skill/SKILL.md`**

```markdown
---
name: token-scope
description: Analyze Claude Code output token spend — by tool, project, session, and thinking blocks. Reads ~/.claude/__store.db in read-only mode.
version: 1.0.0
author: nhangen
---

# token-scope

Analyze your Claude Code output token spend without leaving the terminal.

## Prerequisites

Bun 1.1.0+ — install from https://bun.sh

## Setup

```bash
git clone https://github.com/nhangen/token-scope ~/ML-AI/token-scope
cd ~/ML-AI/token-scope
bun install
claude skill add ~/ML-AI/token-scope/skill/SKILL.md
```

## Usage

```
token-scope                        # Summary by-tool, by-project, weekly trend
token-scope --tool bash            # Bash command breakdown
token-scope --project wp-content   # Filter to one project
token-scope --sessions             # List recent sessions
token-scope --session <id>         # Turn-by-turn breakdown
token-scope --thinking             # Thinking token analysis
token-scope --since 7d --json      # JSON output
```

## execute

```bash
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bun &> /dev/null; then
  echo "Error: bun is not installed. Install from https://bun.sh and re-run."
  exit 1
fi

bun run "$REPO_DIR/src/cli.ts" "$@"
exit $?
```
```

- [ ] **Step 2: Commit**

```bash
git add skill/SKILL.md
git commit -m "Add Claude Code skill manifest"
```

---

## Task 15: CI Configuration

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Read Bun version
        id: bun-version
        run: echo "version=$(grep bun .tool-versions | awk '{print $2}')" >> $GITHUB_OUTPUT

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ steps.bun-version.outputs.version }}

      - name: Install dependencies
        run: bun install

      - name: Run tests
        run: bun test

      - name: Typecheck
        run: bun tsc --noEmit
```

- [ ] **Step 2: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

jobs:
  test-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .tool-versions
      - run: bun install
      - run: bun test
      - run: bun tsc --noEmit

  build:
    needs: test-gate
    strategy:
      matrix:
        include:
          - target: bun-macos-arm64
            os: macos-latest
            artifact: token-scope-macos-arm64
          - target: bun-macos-x64
            os: macos-latest
            artifact: token-scope-macos-x64
          - target: bun-linux-x64
            os: ubuntu-22.04
            artifact: token-scope-linux-x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .tool-versions
      - run: bun install
      - run: bun build --compile --target=${{ matrix.target }} src/cli.ts --outfile ${{ matrix.artifact }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ matrix.artifact }}

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          path: artifacts/
      - uses: softprops/action-gh-release@v2
        with:
          files: artifacts/**/*
          generate_release_notes: true
```

- [ ] **Step 3: Commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "Add CI workflow and release binary build pipeline"
```

---

## Task 16: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# token-scope

**Google Analytics for Claude Code output tokens.**

Reads Claude Code's `~/.claude/__store.db` in read-only mode and shows exactly where your output tokens go — by tool, project, session, and thinking blocks.

## Why

Claude Code users have no built-in visibility into output token spend. `token-scope` fills that gap retroactively, with no proxy, no tokenizer, and no daemon. The data is already in `__store.db`.

## Prerequisites

[Bun](https://bun.sh) 1.1.0+

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

```bash
git clone https://github.com/nhangen/token-scope ~/ML-AI/token-scope
cd ~/ML-AI/token-scope
bun install
```

As a Claude Code skill:
```bash
claude skill add ~/ML-AI/token-scope/skill/SKILL.md
```

Direct invocation:
```bash
bun run ~/ML-AI/token-scope/src/cli.ts
```

## Usage

| Command | What it shows |
|---------|--------------|
| `token-scope` | Summary: totals, by-tool, by-project, weekly trend |
| `token-scope --tool bash` | Bash command category breakdown |
| `token-scope --tool agent` | Agent task breakdown |
| `token-scope --project wp-content` | Filtered to one project |
| `token-scope --sessions` | Sessions list sorted by cost |
| `token-scope --session abc123` | Turn-by-turn breakdown |
| `token-scope --thinking` | Thinking token analysis |
| `token-scope --since 7d --json` | Last 7 days as JSON |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--since <Nd>` | `30d` | Time window: Nh, Nd, Nw |
| `--limit <n>` | `20` | Max rows per table |
| `--json` | — | Machine-readable JSON |
| `--db <path>` | `~/.claude/__store.db` | Override DB path |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `TOKEN_SCOPE_DB` | Override database path |
| `TOKEN_SCOPE_PRICING_FILE` | Custom pricing JSON (same schema as `src/pricing.ts`) |
| `NO_COLOR` | Disable ANSI color |

## Accuracy Notes

- **Costs** — read from `cost_usd` column in the database (exact)
- **Thinking tokens** — character-ratio estimates (±15–30% error), prefixed with `~`
- **Cache savings** — estimated using pricing constants in `src/pricing.ts`
- **Tool attribution** — per-turn dominant tool (largest input character count); no double-counting

## Roadmap

- **Phase 1 (now):** Terminal reports
- **Phase 2:** Compiled binaries, Homebrew, HTML dashboard
- **Phase 3:** Optimization recommendations

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Add README with install, usage, flags, and accuracy notes"
```

---

## Task 17: Final Integration Test

- [ ] **Step 1: Run full test suite**

```bash
cd ~/ML-AI/token-scope && bun test
```

Expected: 50+ pass, 0 fail across all three test files.

- [ ] **Step 2: Final typecheck**

```bash
bun tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Full end-to-end smoke test**

```bash
export TOKEN_SCOPE_DB=tests/fixtures/__store.db

bun run src/cli.ts
bun run src/cli.ts --tool bash
bun run src/cli.ts --tool agent
bun run src/cli.ts --project token-scope
bun run src/cli.ts --sessions
bun run src/cli.ts --session sess-a1
bun run src/cli.ts --thinking
bun run src/cli.ts --since 7d --json | python3 -m json.tool > /dev/null && echo "JSON valid"
bun run src/cli.ts --version
bun run src/cli.ts --help
```

Expected: all commands run without error. JSON validates.

- [ ] **Step 4: Test error handling**

```bash
# Mutual exclusion
bun run src/cli.ts --tool bash --project foo 2>&1; echo "Exit: $?"
```
Expected: error message, exit code 1.

```bash
# DB not found
TOKEN_SCOPE_DB=/tmp/zzz-does-not-exist/__store.db bun run src/cli.ts 2>&1; echo "Exit: $?"
```
Expected: "Database not found at...", exit code 1.

- [ ] **Step 5: Push to remote (after CI passes)**

```bash
git push origin main
```

Wait for CI green (test + typecheck).

---

## Self-Review: Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| Read-only DB (`{ readonly: true }`) | Task 5 `openDb` |
| DB path: flag → env → XDG → default | Task 5 `resolveDbPath` |
| `json_valid()` guard on all `json_each` queries | Task 5 JOIN constant |
| Tool attribution = dominant tool by input char size | Task 3 `resolveDominantTool` |
| Thinking = char-ratio proxy, `~` prefix everywhere | Task 3 `estimateThinkingTokens` + all reports |
| `src/pricing.ts` with full model table | Task 4 |
| `TOKEN_SCOPE_PRICING_FILE` override | Task 4 `loadPricingMap` |
| `NO_COLOR` support | Task 6 `USE_COLOR` check |
| Mutual exclusion for all report flags | Task 7 `parseArgs` |
| `--session` ignores `--since` with notice | Task 11 |
| Project multi-match disambiguation | Task 10 |
| Session partial prefix matching (min 6 chars) | Task 7 + Task 11 |
| All 6 reports implemented | Tasks 8–12 |
| `--json` for every report mode | Tasks 8–12 |
| Fixture: 3 projects, old rows, thinking, multi-tool, malformed, NULL cost | Task 2 |
| `seed.sql` checked in for reproducibility | Task 2 |
| Tests run against fixture (no real DB) | Task 1 `bunfig.toml` preload |
| CI: test + typecheck on push | Task 15 |
| `skill/SKILL.md` manifest | Task 14 |
| Zero runtime npm dependencies | Task 1 `package.json` |
| `.tool-versions` pins Bun | Task 1 |

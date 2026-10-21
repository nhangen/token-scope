// Preloaded before every bun test run.
// Points TOKEN_SCOPE_DB at the fixture so tests never touch a real user's database.
import { mock } from "bun:test";
import * as bunTest from "bun:test";

mock.module("claude-code/testing", () => ({
  test: bunTest.test,
  expect: bunTest.expect,
  describe: bunTest.describe,
  it: bunTest.it,
  beforeEach: bunTest.beforeEach,
  afterEach: bunTest.afterEach,
}));

process.env["TOKEN_SCOPE_DB"] = new URL("./fixtures/__store.db", import.meta.url).pathname;
process.env["TOKEN_SCOPE_PROJECTS_DIR"] = new URL("./fixtures/projects", import.meta.url).pathname;
process.env["TOKEN_SCOPE_PROMPT_CACHE_LOG"] = "/nonexistent/token-scope-test/prompt-cache.jsonl";

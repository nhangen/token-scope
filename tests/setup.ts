// Preloaded before every bun test run.
// Points TOKEN_SCOPE_DB at the fixture so tests never touch a real user's database.
process.env["TOKEN_SCOPE_DB"] = new URL("./fixtures/__store.db", import.meta.url).pathname;
process.env["TOKEN_SCOPE_PROJECTS_DIR"] = new URL("./fixtures/projects", import.meta.url).pathname;

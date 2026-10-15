/**
 * Ambient type declarations for the `claude-code` plugin module (engine v2.1.294 API
 * surface used by this plugin). These declarations exist only for local and CI
 * type-checking: at runtime the Claude Code plugin engine provides `claude-code`
 * and `claude-code/testing` natively (see hooks/register.ts and hooks/register.test.ts),
 * so no npm package is required or installed.
 *
 * Keep this file in sync with the engine hook API. The parameter types below are
 * intentionally minimal (event/next as `any`) because the engine does not publish
 * a stable, documented TS API for hook handlers.
 */

declare module "claude-code" {
  export type Timer = { cancel(): void };

  export type HookContext = {
    env: { get(name: string): Promise<string | undefined> };
    settings: { read(): Promise<Record<string, unknown>> };
    clock: { now(): Promise<number>; every(ms: number, fn: () => void): Timer };
    ui: { status(text: string | undefined): void };
  };

  export type Register = (
    on: (event: string, handler: (...args: any[]) => unknown) => void,
    options?: Record<string, unknown>,
  ) => void;
}

declare module "claude-code/testing" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function expect(actual: unknown): any;
}

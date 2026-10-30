/** The part of the Workers runtime's `cloudflare:workers` module the Worker imports, for tests run in Node (`vitest.config.ts`). */
export abstract class WorkflowEntrypoint<Env = unknown, _T = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

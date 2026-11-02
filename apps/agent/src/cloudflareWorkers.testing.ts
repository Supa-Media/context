/** The part of the Workers runtime's `cloudflare:workers` module the Worker imports, for tests run in Node (`vitest.config.ts`). */
export abstract class WorkflowEntrypoint<Env = unknown, _T = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

/** A named RPC entrypoint (`texRoutineDue.ts`): its methods are called as the Workers runtime calls them. */
export abstract class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

/** Node stand-ins for the runtime's `cloudflare:workers` classes, enough for the tests. */
export class DurableObject<E = unknown> {
  ctx: unknown;
  env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class WorkerEntrypoint<E = unknown> {
  env: E;
  constructor(_ctx: unknown, env: E) {
    this.env = env;
  }
}

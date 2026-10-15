// Vitest runs in Node, where the Workers runtime's own module does not exist.
// Only the shape index.ts extends is needed: the Durable Object it declares
// is tested through src/idle.ts, apart from the runtime.
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

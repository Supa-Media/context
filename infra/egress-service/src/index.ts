import { DurableObject } from "cloudflare:workers";
import { handleRequest } from "./handler";

interface Env {
  EGRESS: DurableObjectNamespace<EgressContainer>;
  EGRESS_SERVICE_SECRET?: string;
}

export class EgressContainer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const container = ctx.container!;
      await container.setInactivityTimeout(10 * 60 * 1000);
      if (!container.running) container.start();
      const port = container.getTcpPort(8080);
      let lastError: unknown;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await port.fetch("http://container/ready");
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw lastError;
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.ctx.container!.getTcpPort(8080).fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

// One Worker per pull request preview, `context-emulators-pr<N>`: every
// emulator in services.mjs, its state in one Durable Object so a calendar event
// a test adds is there for the gateway's next read. Fake data only, and
// nothing real is ever reachable through it.
import { DurableObject } from "cloudflare:workers";
import { createEmulators } from "./index.mjs";

export default {
  async fetch(request, env) {
    const stub = env.EMULATORS.get(env.EMULATORS.idFromName("all"));
    return stub.fetch(request);
  },
};

export class Emulators extends DurableObject {
  #emulators = null;

  async fetch(request) {
    this.#emulators ??= createEmulators({
      publicUrl: new URL(request.url).origin,
      persistence: {
        load: async () => (await this.ctx.storage.get("state")) ?? null,
        save: async (data) => this.ctx.storage.put("state", data),
      },
    });
    const emulators = await this.#emulators;
    return emulators.fetch(request);
  }
}

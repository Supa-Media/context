import { createAdapterRuntime } from "@emulators/core";
import { SERVICES } from "./services.mjs";
import { defaultSeed } from "./seed.mjs";

export { SERVICES, service } from "./services.mjs";
export { emulatedUrl, emulatedHosts } from "./hosts.js";
export { defaultSeed, PERSONAS, personaEmail } from "./seed.mjs";

/**
 * Every emulator in SERVICES behind one fetch handler: `<origin>/<service>/...`.
 *
 * `persistence` is emulate's { load, save } adapter (a Durable Object's storage
 * in a preview, nothing in a test). `publicUrl` is the origin callers reach it
 * on, which emulate advertises in OAuth discovery and redirects.
 */
export async function createEmulators({ seed = defaultSeed(), persistence, publicUrl, only } = {}) {
  const chosen = only ? SERVICES.filter((s) => only.includes(s.name)) : SERVICES;
  const services = {};
  for (const svc of chosen) services[svc.name] = { emulator: await svc.load(), seed: seed[svc.name] };
  const runtime = createAdapterRuntime({ services, persistence, publicUrl }, (mount, name) => `${mount}/${name}`);
  const names = new Set(Object.keys(services));
  return {
    names: [...names],
    async fetch(request) {
      const segments = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (!names.has(segments[0])) {
        return Response.json({ error: "no such emulator", emulators: [...names] }, { status: 404 });
      }
      return runtime.handle(request, segments, "");
    },
    close: () => runtime.close(),
  };
}

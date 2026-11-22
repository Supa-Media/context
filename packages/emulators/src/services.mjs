// How each emulator in routes.js is loaded: emulate's `@emulators/*` package,
// or one of our own under src/own/<name>/ in the same plugin shape. Kept apart
// from routes.js so code that only rewrites URLs never bundles an emulator.
import { ROUTES } from "./routes.js";

const LOADERS = {
  google: () => import("@emulators/google"),
  resend: () => import("@emulators/resend"),
};

export const SERVICES = ROUTES.map((route) => {
  const load = LOADERS[route.name];
  if (!load) throw new Error(`emulator ${route.name} has no loader in services.mjs`);
  return { ...route, load };
});

export function service(name) {
  return SERVICES.find((s) => s.name === name) ?? null;
}

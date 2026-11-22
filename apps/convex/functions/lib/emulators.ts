/**
 * A pull request preview's control plane sends Google and Resend calls to the
 * preview's own emulators (packages/emulators) instead of the real services.
 *
 * On only when the deployment is a preview (`APP_ENV=preview`, set by
 * packages/sandbox/src/convex-env.mjs with `EMULATORS_ORIGIN`), and the origin
 * must be a `context-emulators-pr<N>` Worker or the URL rewriter refuses it.
 * Imported for its effect by every module that calls Google, before the call.
 */
import { emulatedUrl, emulatingFetch } from "../../../../packages/emulators/src/hosts.js";

export function emulatorsOrigin(env: Record<string, string | undefined> = process.env): string | null {
  return env.APP_ENV === "preview" && env.EMULATORS_ORIGIN ? env.EMULATORS_ORIGIN : null;
}

/** A real Google or Resend URL as this deployment should reach it: the emulator's on a preview, itself elsewhere. */
export function outsideUrl(real: string, env: Record<string, string | undefined> = process.env): string {
  const origin = emulatorsOrigin(env);
  return origin ? (emulatedUrl(real, origin) ?? real) : real;
}

/** Wraps `target.fetch` once on a preview. Returns whether it did. */
export function installEmulators(env: Record<string, string | undefined> = process.env, target: { fetch: typeof fetch } = globalThis): boolean {
  const origin = emulatorsOrigin(env);
  const current = target.fetch as typeof fetch & { emulated?: boolean };
  if (!origin || current.emulated) return false;
  const wrapped = emulatingFetch(current.bind(target), origin) as typeof fetch & { emulated?: boolean };
  wrapped.emulated = true;
  target.fetch = wrapped;
  return true;
}

installEmulators();

/**
 * A pull request preview's gateway sends Google and Resend calls to its own
 * emulators (packages/emulators) instead of the real services.
 *
 * Switched on at build time only: the preview deploy passes
 * `--define __CONTEXT_EMULATORS__:"https://context-emulators-pr<N>...."`, and
 * no staging or production deploy defines it, so there is no setting that could
 * turn it on there. Unset, this module changes nothing.
 */
import { emulatingFetch } from "../../../packages/emulators/src/hosts.js";

/* global __CONTEXT_EMULATORS__ */
const ORIGIN = typeof __CONTEXT_EMULATORS__ === "string" ? __CONTEXT_EMULATORS__ : null;

/** Wraps `target.fetch` once when an emulators origin is given. Returns whether it did. */
export function installEmulators(origin = ORIGIN, target = globalThis) {
  if (!origin || target.fetch?.emulated) return false;
  const wrapped = emulatingFetch(target.fetch.bind(target), origin);
  wrapped.emulated = true;
  target.fetch = wrapped;
  return true;
}

installEmulators();

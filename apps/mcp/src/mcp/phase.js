/**
 * Named phases inside a tool (`tools/notes/write.js`): `phase(store, name, run)` times `run` as
 * `phase:<name>` when the store carries a timer, and otherwise just runs it. `laySavePhase` lays that timer on a
 * store the MCP entry point opened (`http/mcpRoute.js`), so the phases show beside its `store:<op>` points.
 */

const PHASE_NAME = /^[a-z_]{1,40}$/;

/** `(name, run)` timed through the entry point's step as `phase:<name>`; an invalid name runs untimed. */
export function phaseTimer(mcp) {
  const timer = (name, run) => (typeof name === "string" && PHASE_NAME.test(name) ? mcp.step(`phase:${name}`, run) : run());
  // A time measured inside a workspace object, on its clock: `inside:<name>`, beside the call's own `obj:<op>`.
  timer.took = (name, ms) => {
    if (typeof name === "string" && PHASE_NAME.test(name) && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) mcp.point(`inside:${name}`, ms);
  };
  // The call failed inside a 200 answer (a tool threw): the entry point's `to_response` says failed.
  timer.failed = () => mcp.fail();
  return timer;
}

/** Record `ms`, measured elsewhere, as `inside:<name>` when the store carries a timer; otherwise nothing. */
export function phaseTook(store, name, ms) {
  if (typeof store?.phase?.took === "function") store.phase.took(name, ms);
}

/** Mark this request's call failed when the store carries a timer; otherwise nothing. */
export function phaseFailed(store) {
  if (typeof store?.phase?.failed === "function") store.phase.failed();
}

export function phase(store, name, run) {
  return typeof store?.phase === "function" ? store.phase(name, run) : run();
}

/** Lays `store.phase` once, non-enumerable and read-only, the way `routing.js` lays its own doors. */
export function laySavePhase(store, mcp) {
  if (!store || typeof store !== "object" || Object.prototype.hasOwnProperty.call(store, "phase")) return store;
  Object.defineProperty(store, "phase", {
    value: phaseTimer(mcp),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return store;
}

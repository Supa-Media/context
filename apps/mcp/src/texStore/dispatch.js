/**
 * How a Tex store's alarm hands a due routine on (`texStore.js`, `alarm()`):
 * one call to the texting Worker's named RPC entrypoint `TexRoutines.routineDue`
 * (`apps/agent/src/texRoutineDue.ts`), through the gateway's `TEXTING` service
 * binding, which names that entrypoint in `wrangler.toml`.
 *
 * A named entrypoint is reachable only through a service binding, never over
 * HTTP, so the call needs no bearer. The object never holds a grant or a token:
 * the call carries the owner and the routine's path, and the texting Worker
 * finds the run itself.
 *
 * Resolves `{next}`, or rejects when the routine could not be handed on; the
 * object keeps a rejected one and tries it again.
 */

/** The dispatch when nothing is wired: every due routine waits, and none runs. */
export async function unwiredDispatch() {
  throw new Error("no texting Worker is wired to run Tex's routines");
}

/** The dispatch for a Worker's `env`: its `TEXTING` binding. Without it, the unwired one. */
export function routineDispatchFor(env) {
  const texting = env?.TEXTING;
  if (!texting) return unwiredDispatch;
  return async (routine) => {
    const answer = await texting.routineDue({ owner: routine.payload?.owner, id: routine.id });
    const next = answer?.next;
    return { next: Number.isSafeInteger(next) && next >= 0 ? next : null };
  };
}

/**
 * How a Tex store's alarm hands a due routine on (`texStore.js`, `alarm()`):
 * one call to the texting Worker's named RPC entrypoint `TexRoutines.routineDue`
 * (`packages/tex/worker/texRoutineDue.ts`), through the gateway's `TEXTING` service
 * binding, which names that entrypoint in `wrangler.toml`.
 *
 * A named entrypoint is reachable only through a service binding, never over
 * HTTP, so the call needs no bearer. The object never holds a grant or a token:
 * the call carries the owner and the routine's path, and the texting Worker
 * finds the run itself.
 *
 * An alarm for Tex in mail (`payload.mail`) goes to `TexRoutines.texMailDue` instead, with the owner alone: the Worker
 * claims whatever runs wait for that person from the control plane.
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
    // Mail to the person's own Tex (`apps/mcp/src/mail/deliver.js` `wakeTex`): the Worker claims and runs what waits.
    if (typeof routine.payload?.mail === "string") {
      if (typeof texting.texMailDue !== "function") throw new Error("no texting Worker is wired to run Tex in mail");
      await texting.texMailDue({ owner: routine.payload.owner });
      return { next: null };
    }
    const answer = await texting.routineDue({ owner: routine.payload?.owner, id: routine.id });
    const next = answer?.next;
    return { next: Number.isSafeInteger(next) && next >= 0 ? next : null };
  };
}

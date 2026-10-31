/**
 * How a Tex store's alarm hands a due routine on (`texStore.js`, `alarm()`):
 * one `POST` through the gateway's service binding to the texting Worker's
 * `/tex/routine-due` (`apps/agent/src/texRoutineDue.ts`), which runs the
 * routine through the path the cron uses and answers when it runs next.
 *
 * The object never holds a grant or a token: the call carries the owner and
 * the routine's path, and the texting Worker finds the run itself. The bearer
 * is the Worker's own `TEX_ALARM_SECRET`, which the texting Worker checks, since
 * a service binding proves where a call came from and not who it is for.
 *
 * Resolves `{next}`, or throws when the routine could not be handed on; the
 * object keeps a thrown one and tries it again.
 */

export const TEXTING_ROUTINE_DUE = "https://texting.internal/tex/routine-due";

/** The dispatch when nothing is wired: every due routine waits, and none runs. */
export async function unwiredDispatch() {
  throw new Error("no texting Worker is wired to run Tex's routines");
}

/**
 * The dispatch for a Worker's `env`: the `TEXTING` service binding and
 * `TEX_ALARM_SECRET`. Missing either, it is the unwired one.
 */
export function routineDispatchFor(env) {
  const texting = env?.TEXTING;
  const secret = typeof env?.TEX_ALARM_SECRET === "string" ? env.TEX_ALARM_SECRET.trim() : "";
  if (!texting || typeof texting.fetch !== "function" || secret === "") return unwiredDispatch;
  return async (routine) => {
    const response = await texting.fetch(
      new Request(TEXTING_ROUTINE_DUE, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ owner: routine.payload?.owner, id: routine.id }),
      }),
    );
    if (!response.ok) throw new Error(`the texting Worker refused a routine alarm (${response.status})`);
    const { next } = await response.json();
    return { next: Number.isSafeInteger(next) && next >= 0 ? next : null };
  };
}

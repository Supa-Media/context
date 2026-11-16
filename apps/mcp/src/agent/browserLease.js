/**
 * ONE QUESTION DRIVES A CHAT'S BROWSER AT A TIME (Dev2, 2026-11-16).
 *
 * A person's or a group chat's Browserbase browser is one live session, found
 * by its tag (`browserProviders.js`). On 2026-11-16 two passes of one
 * background job drove it at once: their sign-in fills interleaved and the
 * site answered that the password was wrong, which Tex then reported. Each
 * question (`browserSession` in `browse.js`) now names itself with a holder
 * id on every call; the screenshot Worker gives the browser to one holder at
 * a time and answers anyone else 409 `{ busy: true }` with nothing run
 * (`infra/site-shots/src/lease.ts`). The lease is let go when the question
 * ends, and runs out on its own ninety seconds past the last step of a
 * question that died or disconnected; the next one drives the same browser.
 *
 * A busy browser is waited for. A background job or a routine is in no
 * hurry, so it waits most of the browse tool's own limit (160 s,
 * `texEntryPoint/runTheModel.js`); a chat turn, which a person is watching,
 * waits briefly. Still busy, the model is told plainly that the browser is in
 * use by another job and to try again shortly: never anything that reads as
 * a sign-in or a password failing, since nothing was typed.
 */

/** Said to the model when the browser stayed busy past the wait. */
export const BROWSER_BUSY =
  "This chat's browser is in use by another job right now, so nothing ran. Try the same steps again shortly; nothing is wrong with the site or the sign-in.";

/** How long a job (patient) and a chat turn wait for the browser, and how often they ask. */
export const PATIENT_WAIT_MS = 120_000;
export const BRIEF_WAIT_MS = 10_000;
export const PATIENT_POLL_MS = 5_000;
export const BRIEF_POLL_MS = 2_500;

/** A question's holder id: random, naming nobody. */
export function newHolder() {
  return crypto.randomUUID();
}

/** An error `browse.js` tells apart from a failed step: the browser was busy and nothing ran. */
export function busyError() {
  const error = new Error("browser busy");
  error.busy = true;
  return error;
}

async function isBusy(response) {
  if (response.status !== 409) return false;
  const body = await response.clone().json().catch(() => null);
  return body?.busy === true;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends `send()` until the browser is not busy, waiting between tries, and
 * throws `busyError()` once the wait is spent. Any other answer is returned.
 */
export async function untilFree(send, { patient = false, sleep = wait, now = Date.now } = {}) {
  const deadline = now() + (patient ? PATIENT_WAIT_MS : BRIEF_WAIT_MS);
  const poll = patient ? PATIENT_POLL_MS : BRIEF_POLL_MS;
  for (;;) {
    const response = await send();
    if (!(await isBusy(response))) return response;
    if (now() + poll > deadline) {
      console.log(JSON.stringify({ event: "browse_busy", patient }));
      throw busyError();
    }
    await sleep(poll);
  }
}

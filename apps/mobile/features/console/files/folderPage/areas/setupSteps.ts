/**
 * The steps that set a bot up, or put it back in good standing, tied to its health (Dev, 2026-11-27: "can you fix this
 * side panel to be more clear on how to set things up?", after a "Not answering" bot left him asking how to fix it).
 * There is one way back from every bad state: copy its setup prompt, paste it into the bot's own chat in its app, and
 * wait for the health above to turn green. What changes is what the bot does with the prompt and what turns it green,
 * which follow `botHealth.tsx`'s rules:
 *
 *   Not set up / webhook       → it saves its webhook and sends a test; green once the test is answered.
 *   Webhook failing            → it saves its webhook again and sends a test; green once the test is answered.
 *   Not answering              → it reconnects, finds the routines waiting for it, and answers them; green once it has.
 *   Not set up / Not checking / Stopped checking, checking in → it sets its 5-minute check-in up; green at its first.
 *
 * A healthy bot, or one waiting for its first call (Not tried yet), has no steps.
 */

import type { BotHealth } from "./botHealth";

export interface SetupSteps {
  /** "Set up Architect", "Get Architect answering again". */
  readonly title: string;
  /** Step 2: what pasting the prompt does. */
  readonly paste: string;
  /** Step 3: what turns it green. */
  readonly green: string;
}

/** The routines waiting for an answer, counted from health's why line. */
function waiting(health: BotHealth): string {
  const many = /(\d+) routines have/.exec(health.why);
  return many === null ? "the routine waiting for it" : `the ${many[1]} routines waiting for it`;
}

export function setupSteps(name: string, app: string | null, health: BotHealth | undefined, way: "webhook" | "check"): SetupSteps | null {
  const where = `Paste it into ${name}'s own chat${app === null ? "" : ` in ${app}`}.`;
  const state = health?.state ?? "not set up";
  if (state === "not answering") {
    return { title: `Get ${name} answering again`, paste: `${where} It reconnects to Context and finds what is waiting for it.`, green: `The status above turns green once it answers ${waiting(health as BotHealth)}.` };
  }
  if (way === "check") {
    if (state === "not set up" || state === "not checking") return { title: `Set up ${name}`, paste: `${where} It connects to Context, asks you to sign in, and sets up its check-in every 5 minutes.`, green: "The status above turns green at its first check-in, within 5 minutes." };
    if (state === "stopped checking") return { title: `Get ${name} checking in again`, paste: `${where} It sets its 5-minute check-in up again, on a timer that outlasts its chat.`, green: "The status above turns green at its next check-in, within 5 minutes." };
    return null;
  }
  if (state === "not set up") return { title: `Set up ${name}`, paste: `${where} It connects to Context, asks you to sign in and saves its webhook, and Context sends it a test.`, green: "The status above turns green once the test is answered." };
  if (state === "webhook failing") return { title: `Get ${name} reachable again`, paste: `${where} It saves its webhook again, and Context sends it a test.`, green: "The status above turns green once the test is answered." };
  return null;
}

/** The words for a bot that just came back, by its good state: "Architect is answering." */
export function backWords(name: string, health: BotHealth): string {
  return health.state === "checking" ? `${name} is checking in.` : `${name} is answering.`;
}

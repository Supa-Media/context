/**
 * `dream_now` (`manage` action `dream_now`): start Tex's dream for the person
 * now instead of at 3 am (decided by the owner, 2026-10-17, for onboarding;
 * docs/decisions/texting-assistant/dreams.md).
 *
 * Nothing runs here. The control plane (`/gateway/dreams/start`, through
 * `store.dreamNow`, attached in `http/routing.js`) decides from this
 * connection's own token whether its person may ask: the owner of their own
 * personal workspace, a plan that includes dreams, with a linked phone, none under way, none asked
 * in the window. It then makes their dream due, and the texting Worker's
 * minute cron runs it under the dreams client's own grant, like a nightly one.
 * This turns its answer into a sentence the agent can pass on.
 */

import { toolError, toolText } from "./results.js";

const NOT_YOURS =
  "Not started: only the owner can start a dream, in their own personal workspace (not a shared one), from a connection with full access.";

function when(epochMs) {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const ANSWERS = {
  started: () =>
    toolText(
      "Started: Tex's dream will run within a minute or two and takes a few minutes. It rewrites tex/about-me.md and logs " +
        "what changed in tex/dreams/. Nothing is texted when it finishes: read tex/about-me.md in a later turn and confirm it with them.",
    ),
  running: () =>
    toolText("Already under way: a dream is running or about to start. Its result will be in tex/about-me.md in a few minutes."),
  recent: (dream) =>
    toolError(
      "Not started: a dream was already asked for recently" +
        (Number.isFinite(dream.retryAt) ? `; another can be asked for after ${when(dream.retryAt)}.` : ".") +
        " tex/about-me.md has what the last one wrote.",
    ),
  not_included: () =>
    toolError("Not started: their plan doesn't include dreams. Without it, Tex keeps tex/about-me.md up to date as it texts with them."),
  daily_limit: () => toolError("Not started: today's use of Tex is used up. Tonight's dream will still run if one is due."),
  unavailable: () => toolError("Not started: Tex's dreams are switched off on this deployment just now."),
  not_texting: () =>
    toolError("Not started: Tex dreams only for someone who texts with it, and this person has no linked phone, or texting is paused."),
};

export async function toolDreamNow(store, scope) {
  // The owner's, like a link: anything below the private tier is refused
  // before the control plane is asked, which refuses it again.
  if (scope !== "private") return toolError(NOT_YOURS);
  if (typeof store?.dreamNow !== "function") return toolError("Not started: dreams are not available on this deployment.");
  let dream;
  try {
    dream = await store.dreamNow();
  } catch {
    return toolError("Not started: the request could not be sent just now. Try again later.");
  }
  if (dream === null || dream === undefined) return toolError(NOT_YOURS);
  const answer = ANSWERS[dream.status];
  return answer ? answer(dream) : toolError("Not started: the request could not be sent just now. Try again later.");
}

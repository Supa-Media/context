/**
 * WHAT A HELD CALL TELLS TEX: FACTS, NEVER WORDS (Dev2, 2026-11-26; the no-scripted-wording rule,
 * `docs/decisions/texting-assistant/no-scripted-wording.md`).
 *
 * A texted call that waits for a person's OK used to come back as instructions ("Held for their 👍 … Say in one short
 * line …") and the gateway then texted its own card under Tex's line ("Here's the email I'd send … give it a 👍"). Now
 * the call comes back as what is true: it is held, nothing was done, who alone may OK it, and the exact copy they are
 * to see. Tex writes the ask itself, its own text is what the person 👍s (`textedApprovals.js` `textedAsk`), and how to
 * ask is a Lab prompt module's to say, never this file's.
 */

import { toolError } from "./results.js";

/**
 * A held call's result. `copy`: the exact words the person must see whole (an email, a change, a report), or null;
 * `what`: the gateway's one-line summary of it; `okFrom`: the handle of the one person whose 👍 or yes makes it, or null
 * for the person texting; `because`: why it waits, when a judge said so; `account`: whose own account an offer goes from.
 */
export function heldFacts({ copy = null, what = null, okFrom = null, because = null, account = null } = {}) {
  const facts = {
    held: true,
    done: false,
    ok_from: okFrom ? `@${okFrom}` : "the person texting",
    ok_by: ["👍", "yes"],
    ...(typeof what === "string" && what !== "" ? { what } : {}),
    ...(typeof because === "string" && because !== "" ? { because } : {}),
    // An offer to somebody else in a group: it goes from their own account, on their yes, by the same call without `as`.
    ...(typeof account === "string" && account !== "" ? { from_account_of: `@${account}`, on_their_yes: "same call without as" } : {}),
    ...(typeof copy === "string" && copy.trim() !== "" ? { copy: copy.trim(), copy_shown_whole: "required" } : {}),
  };
  return { ...toolError(JSON.stringify(facts)), held: true };
}

/** The handle whose OK a texted hold waits for: the tagger in a group chat, nobody named in a one-to-one. */
export function okFromOf(session) {
  const from = session?.egress?.group?.from;
  return typeof from === "string" && from !== "" ? from : null;
}

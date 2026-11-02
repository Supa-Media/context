/**
 * A 👎 ON THE ASK IS THE NO (a new tester, 2026-10-30: Tex said "say yes"
 * where a 👍 or 👎 would do).
 *
 * A 👍 on a held ask already sent it (`thumbsUpIsYes`). A 👎 reached the model
 * as a bare emoji with the words it was on: nothing was dropped, the ask
 * stayed armed for twelve hours, and a later "yes" about anything else could
 * still send the email. Now a 👎 on the ask's own words drops it before any
 * model runs, the way a texted "no" does (`thumbsDownIsNo`,
 * `src/agent/textedApprovals.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `route.js` not mapping `thumbsDown` to "no". → `a 👎 on the ask drops
 *     it…` and `…a later yes sends nothing` fail.
 *  2. `thumbsDownIsNo` without the armed-ask match (any 👎 is a no). → `a 👎 on
 *     other words drops nothing` fails.
 *  3. The 👎 left out of `NO`. → `a typed 👎 is a no` fails.
 */

import { ask, request, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { approvalVerdict } from "../src/agent/textedApprovals.js";

const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });
const EMAIL = { to: ["jo@example.com"], subject: "Thursday", body: "Thursday works for me." };

export async function runEmailGateThumbDownChecks(check) {
  check("a typed 👎 is a no, and a typed 👍 still a yes", approvalVerdict("👎") === "deny" && approvalVerdict("👎🏽") === "deny" && approvalVerdict("👍") === "approve");

  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  const sends = () => controlPlane.emailCalls.filter((entry) => !entry.check);
  try {
    controlPlane.flags.emailSender = "seyi@gmail.example";
    const hold = async () => {
      model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, verdict("unasked", "not asked in these texts"), { text: "Drafted it." }]);
      const turn = await ask(env, TOKEN_TEXTS, "thursday is fine");
      return turn.body?.verbatim?.[0] ?? "";
    };

    const shown = await hold();
    check("the email is held, asked about with a 👍", pending().length === 1 && shown.startsWith("Here's the email I'd send:") && shown.includes("👍"));

    // A 👎 on some other text of Tex's is not the no: the ask stays armed.
    model.install([{ text: "Got it." }]);
    await request(env, TOKEN_TEXTS, "/agent", { question: "👎", quoted: "Want me to look for a later train on Thursday instead of the 8:10?", tapback: "Disliked", conversation: "texts" });
    check("a 👎 on other words drops nothing", pending().length === 1);

    const before = sends().length;
    const turns = model.requests.length;
    const no = await request(env, TOKEN_TEXTS, "/agent", { question: "👎", quoted: shown, tapback: "Disliked", conversation: "texts" });
    check(
      "a 👎 on the ask drops it, with no model and nothing sent",
      model.requests.length === turns && sends().length === before && pending().length === 0 && /dropped/i.test(no.body?.answer ?? ""),
    );
    model.install([{ text: "Sounds good." }]);
    await ask(env, TOKEN_TEXTS, "yes");
    check("…and a later yes sends nothing", sends().length === before && pending().length === 0);
  } finally {
    world.restore();
  }
}

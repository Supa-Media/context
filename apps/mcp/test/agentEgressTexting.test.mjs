/**
 * WHAT STILL ASKS BY TEXT, END TO END.
 *
 * The widening gate was removed by the owner on 2026-10-17
 * (docs/decisions/privacy-and-sharing/agent-egress.md): a texted share runs at
 * once, whatever the turn read. What still waits for the person is a call
 * nobody can take back — an email, a calendar change, a handle claim — and
 * this file drives the texted YES and NO that settle one, with a handle claim
 * as the held call. `src/agent/textedApprovals.js` settles a whole YES or NO
 * before any model runs; `src/http/approvals.js` is the app's side.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  5. `settleByText` matching "yes" inside a longer text. → `a text that is
 *     more than yes goes to the model` fails.
 * 17. `disarmTexting` not called before a model turn. → `a yes to a later
 *     question does not release an earlier ask`.
 * 18. `withdrawPending` not called when a turn fails. → `an ask whose turn
 *     failed before the person saw it is not left waiting for a yes`.
 * 20. A routine's text not disarming asks. → `an ok to a routine's text does
 *     not release an ask raised before it`.
 * 22. `rememberRoutineText` not called in `route.js`. → `a reply to a
 *     routine's text reaches a turn that has that text`.
 * 23. `appendTold` not called in `route.js`. → `a text after the ready text
 *     reaches a turn that knows Tex asked them to connect Google`.
 * 21. `remember` not called in `textedSettle.js`. → `the next turn sees
 *     the texted YES and what it released`.
 */

import { ask, request, toolReplies, createEgressWorld } from "./agentEgressFixtures.mjs";
import { TOKEN_CONSOLE, TOKEN_TEXTS, TOKEN_ROUTINE } from "./agentEgressFixtures.mjs";
import { approvalVerdict } from "../src/agent/textedApprovals.js";
import { TOLD } from "../src/agent/conversation.js";

export async function runAgentEgressTextingChecks(check) {
  const world = await createEgressWorld();
  const { model, controlPlane, env, teamVisible, pending } = world;
  const claimed = (slug) => controlPlane.workspaceSetupCalls.some((entry) => entry.dryRun === false && entry.slug === slug);
  const claim = (slug) => ({ toolCalls: [{ name: "create_workspace", args: { slug, name: slug } }] });
  // Deny whatever is waiting, so the next ask starts from an empty queue.
  const approvalRows = async () => (await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? [];
  const sweep = async () => {
    for (const row of await approvalRows()) await request(env, TOKEN_CONSOLE, "/approvals", { id: row.id, action: "deny" });
  };

  try {
    /* ---------------- sharing runs at once ---------------- */

    model.install([
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/fourth.md", visibility: "team", confirm_team_publish: true } }] },
      { text: "Shared fourth with the team." },
    ]);
    const shared = await ask(env, TOKEN_TEXTS, "check the status page and share fourth");
    check(
      "a texted share runs at once, even after a page read",
      shared.status === 200 && teamVisible("2-areas/fourth.md") && pending().length === 0 && !/Just say yes|Should I go ahead\?/.test(shared.body?.answer ?? ""),
    );

    /* ---------------- the Worker's own texts reach the history ---------------- */

    model.install([{ text: "Google's connected. Reading your mail now." }]);
    await request(env, TOKEN_TEXTS, "/agent", { question: "Done", conversation: "texts", told: ["setup", "ready", "../secret", "made up"] });
    const afterReady = JSON.stringify(model.requests.at(-1) ?? {});
    check(
      "a text after the ready text reaches a turn that knows Tex asked them to connect Google",
      afterReady.includes(TOLD.ready) && afterReady.includes(TOLD.setup) && afterReady.indexOf(TOLD.ready) < afterReady.lastIndexOf("Done"),
    );
    check(
      "only the gateway's own fixed lines are written, never a name it does not know",
      !afterReady.includes("../secret") && !afterReady.includes("made up"),
    );

    /* ---------------- a handle claim asks ---------------- */

    model.install([claim("woodshop"), { text: "I can set up @woodshop. Shall I?" }]);
    let before = model.requests.length;
    const asked = await ask(env, TOKEN_TEXTS, "make me a workspace called woodshop");
    const replies = toolReplies(model.requests.at(-1));
    check(
      "a texted handle claim is asked about before it runs",
      asked.status === 200 && /Not done yet/.test(replies[0] ?? "") && !claimed("woodshop") && pending().length === 1,
    );
    check(
      "the ask is in the gateway's own words, after the model's, and the answer says one call waits",
      /Shall I\?\n\nBefore I do that, I need your OK: claim the handle @woodshop/.test(asked.body?.answer ?? "") &&
        /Should I go ahead\?/.test(asked.body?.answer ?? "") &&
        asked.body?.asked === 1,
    );
    before = model.requests.length;
    const yes = await ask(env, TOKEN_TEXTS, "Yes!");
    check(
      "a texted YES runs it without a model, and says so",
      yes.status === 200 &&
        model.requests.length === before &&
        /^Done, I claimed the handle @woodshop/.test(yes.body?.answer ?? "") &&
        claimed("woodshop") &&
        pending().length === 0,
    );
    model.install([{ text: "Nothing is waiting, so: yes what?" }]);
    before = model.requests.length;
    const idleYes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "a YES with nothing waiting is an ordinary text for the model",
      idleYes.status === 200 && model.requests.length === before + 1 && /yes what/.test(idleYes.body?.answer ?? ""),
    );
    const shown = JSON.stringify(model.requests.at(-1) ?? {});
    check(
      "the next turn sees the texted YES and what it released",
      shown.includes("Yes!") && shown.includes("Done: claim the handle @woodshop"),
    );

    model.install([claim("pottery"), { text: "Want @pottery?" }]);
    await ask(env, TOKEN_TEXTS, "make me a pottery workspace");
    before = model.requests.length;
    const no = await ask(env, TOKEN_TEXTS, "no");
    check(
      "a texted NO drops it without a model",
      no.status === 200 &&
        model.requests.length === before &&
        /^OK, dropped: claim the handle @pottery/.test(no.body?.answer ?? "") &&
        !claimed("pottery") &&
        pending().length === 0,
    );

    model.install([claim("garden"), { text: "Want @garden?" }]);
    await ask(env, TOKEN_TEXTS, "make me a garden workspace");
    model.install([{ text: "I will hold off, then." }]);
    before = model.requests.length;
    const longer = await ask(env, TOKEN_TEXTS, "yes but call it something else");
    check(
      "a text that is more than yes goes to the model",
      longer.status === 200 && model.requests.length === before + 1 && pending().length === 1 && !claimed("garden"),
    );
    const stillHeld = await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET");
    const gardenRow = stillHeld.body?.approvals?.find((row) => /garden/.test(row.summary));
    const released = await request(env, TOKEN_CONSOLE, "/approvals", { id: gardenRow?.id, action: "approve" });
    check(
      "what a text held, the app can release",
      released.status === 200 && released.body?.status === "approved" && claimed("garden"),
    );

    check(
      "only a whole yes or a whole no is a verdict",
      approvalVerdict("yes") === "approve" &&
        approvalVerdict("  Go ahead! ") === "approve" &&
        approvalVerdict("Nope.") === "deny" &&
        approvalVerdict("yes, and also move it") === null &&
        approvalVerdict("Yes file it") === "approve" &&
        approvalVerdict("yes please") === "approve" &&
        approvalVerdict("Yes, send it!") === "approve" &&
        approvalVerdict("send it") === "approve" &&
        approvalVerdict("yes but send it to Sam") === null &&
        approvalVerdict("ok thanks") === null &&
        approvalVerdict("I said no last time") === null &&
        approvalVerdict("") === null,
    );

    // A yes belongs to the question just asked, not to one asked a few texts ago.
    model.install([claim("seventh-co"), { text: "Want @seventh-co?" }]);
    await ask(env, TOKEN_TEXTS, "set up seventh co");
    model.install([{ text: "It is 3pm. Want me to remind you about the dentist?" }]);
    await ask(env, TOKEN_TEXTS, "what time is it?");
    model.install([{ text: "Reminder set." }]);
    before = model.requests.length;
    const lateYes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "a yes to a later question does not release an earlier ask",
      lateYes.status === 200 &&
        model.requests.length === before + 1 &&
        !claimed("seventh-co") &&
        !/^Done/.test(lateYes.body?.answer ?? ""),
    );
    await sweep();

    // A text the routines send is not the question a later yes answers.
    model.install([claim("ninth-co"), { text: "Want @ninth-co?" }]);
    await ask(env, TOKEN_TEXTS, "set up ninth co");
    model.install([{ text: "Nothing changed since yesterday." }]);
    await request(env, TOKEN_ROUTINE, "/agent", { routine: { path: "routines/daily/brief.md" } });
    model.install([{ text: "Glad it is quiet." }]);
    before = model.requests.length;
    const okToBrief = await ask(env, TOKEN_TEXTS, "ok");
    check(
      "an ok to a routine's text does not release an ask raised before it",
      okToBrief.status === 200 &&
        model.requests.length === before + 1 &&
        !claimed("ninth-co") &&
        !/^Done/.test(okToBrief.body?.answer ?? ""),
    );
    const afterBrief = JSON.stringify(model.requests.at(-1) ?? {});
    check(
      "a reply to a routine's text reaches a turn that has that text",
      afterBrief.includes("Nothing changed since yesterday.") && afterBrief.includes("Your routine routines/daily/brief.md ran"),
    );
    await sweep();

    // An ask the person was never shown cannot be released by a later yes.
    model.install([claim("eighth-co"), { status: 500 }]);
    const unshown = await ask(env, TOKEN_TEXTS, "set up eighth co");
    model.install([{ text: "Yes to what?" }]);
    before = model.requests.length;
    const unshownYes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "an ask whose turn failed before the person saw it is not left waiting for a yes",
      unshown.status === 502 &&
        model.requests.length === before + 1 &&
        !claimed("eighth-co") &&
        !/^Done/.test(unshownYes.body?.answer ?? ""),
    );
  } finally {
    world.restore();
  }
}

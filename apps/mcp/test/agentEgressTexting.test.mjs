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
import { approvalVerdict, notDone } from "../src/agent/textedApprovals.js";
import { TOLD } from "../src/agent/conversation.js";
import { teamNow } from "./accessRows.mjs";

export async function runAgentEgressTextingChecks(check) {
  const world = await createEgressWorld();
  const { model, controlPlane, env, pending, bucket } = world;
  const teamVisible = (path) => teamNow(controlPlane, "ws_egress", bucket.get("privacy.md")?.body, path);
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
      shared.status === 200 && teamVisible("2-areas/fourth.md") && pending().length === 0 && !/Give it a 👍/.test(shared.body?.answer ?? ""),
    );

    /* ---------------- the Worker's own texts reach the history ---------------- */

    model.install([{ text: "Google's connected. Reading your mail now." }]);
    await request(env, TOKEN_TEXTS, "/agent", { question: "Done", conversation: "texts", told: ["setup", "ready", "../secret", "made up"] });
    const afterReady = JSON.stringify(model.requests.at(-1) ?? {});
    check(
      "a text after the ready text reaches a turn that knows Tex asked them to connect Google",
      afterReady.includes(TOLD.ready) && afterReady.includes(TOLD.setup) && afterReady.indexOf(TOLD.ready) < afterReady.lastIndexOf("Done"),
    );
    model.install([{ text: "Great, send me the link for it." }]);
    await request(env, TOKEN_TEXTS, "/agent", { question: "yes my work one", conversation: "texts", told: ["gmail_main"] });
    const afterGmail = JSON.stringify(model.requests.at(-1) ?? {});
    check(
      "a reply to the Gmail-connected text reaches a turn that knows Tex asked about other Gmails",
      afterGmail.includes(TOLD.gmail_main) && afterGmail.indexOf(TOLD.gmail_main) < afterGmail.lastIndexOf("yes my work one"),
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
      asked.status === 200 && /Held for their 👍/.test(replies[0] ?? "") && !claimed("woodshop") && pending().length === 1,
    );
    check(
      "the ask is in the gateway's own words, after the model's, and the answer says one call waits",
      /Shall I\?\n\nBefore I do that, I need your OK: claim the handle @woodshop/.test(asked.body?.answer ?? "") &&
        /Give it a 👍 and I'll go ahead\./.test(asked.body?.answer ?? "") &&
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
      shown.includes("Yes!") && shown.includes("Done, I claimed the handle @woodshop"),
    );

    // A 👍 whose quote came back changed by Messages and the line (2026-10-22):
    // a toned emoji, punctuation changed. Still the yes.
    model.install([claim("kiln"), { text: "I'd set up @kiln." }]);
    const kilnAsk = (await ask(env, TOKEN_TEXTS, "make me a kiln workspace")).body?.verbatim?.[0] ?? "";
    const toned = kilnAsk.replace("👍", "👍🏽").replace("(handles", "— (handles");
    before = model.requests.length;
    const likedKiln = await request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: toned, tapback: "Liked", conversation: "texts" });
    check(
      "a 👍 whose quote came back with a toned emoji or other punctuation is still the yes",
      kilnAsk.startsWith("Before I do that") && model.requests.length === before && claimed("kiln") && /^Done, I claimed the handle @kiln/.test(likedKiln.body?.answer ?? ""),
    );

    model.install([claim("clay"), { text: "I'd set up @clay." }]);
    const clayAsk = (await ask(env, TOKEN_TEXTS, "make me a clay workspace")).body?.verbatim?.[0] ?? "";
    before = model.requests.length;
    await request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: `${clayAsk.slice(0, 70)}...`, tapback: "Liked", conversation: "texts" });
    check("a 👍 whose quote was cut short with three dots is still the yes", model.requests.length === before && claimed("clay"));

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
    const inTheApp = await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET");
    const gardenId = pending().map((key) => JSON.parse(bucket.get(key).body)).find((record) => /garden/.test(record.summary))?.id;
    const fromTheApp = await request(env, TOKEN_CONSOLE, "/approvals", { id: gardenId, action: "approve" });
    check(
      "a texted ask is answered in the texts and never in the app (Dev2, 2026-10-22)",
      pending().length === 1 &&
        inTheApp.status === 200 &&
        !(inTheApp.body?.approvals ?? []).some((row) => /garden/.test(row.summary)) &&
        typeof gardenId === "string" &&
        fromTheApp.status === 404 &&
        !claimed("garden"),
    );
    model.install([{ text: "I will hold off, then." }]);
    before = model.requests.length;
    const longer = await ask(env, TOKEN_TEXTS, "yes but call it something else");
    check(
      "a text that is more than yes goes to the model, and the ask still stands",
      longer.status === 200 && model.requests.length === before + 1 && pending().length === 1 && !claimed("garden"),
    );
    await ask(env, TOKEN_TEXTS, "no");

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
        approvalVerdict("send") === "approve" &&
        approvalVerdict("Send.") === "approve" &&
        approvalVerdict("send it to Sam") === null &&
        approvalVerdict("yes but send it to Sam") === null &&
        approvalVerdict("ok thanks") === null &&
        approvalVerdict("I said no last time") === null &&
        approvalVerdict("") === null,
    );
    // Dev2, 2026-10-22: "yes please send it already sent 👍" went to the model, which asked again.
    check(
      "a yes said in a sentence is a yes, and anything more is not",
      approvalVerdict("yes please send it already sent 👍") === "approve" &&
        approvalVerdict("👍") === "approve" &&
        approvalVerdict("👍🏽") === "approve" &&
        approvalVerdict("Yes!! send it pls") === "approve" &&
        approvalVerdict("did you send it") === null &&
        approvalVerdict("already sent it") === null &&
        approvalVerdict("yes send it to Sam instead") === null &&
        approvalVerdict("not yet") === null,
    );
    check(
      "a Slack permission refusal is told to the person in their terms",
      /^Not sent: Slack hasn't given me permission for that yet \(it needs im:write\)\. Reconnect Slack/.test(
        notDone("send a Slack message to Jo Park (Acme): \"Hi\"", "Slack hasn't given this connection permission for chat.postMessage yet (it needs im:write). Ask the person to reconnect Slack in Context's Settings, under Apps Tex uses, then try again. Don't tell them it can't be done."),
      ) && notDone("do x", "it broke") === "I tried to do x, but: it broke",
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

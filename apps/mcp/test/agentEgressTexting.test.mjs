/**
 * THE EGRESS GATE, END TO END: an AI client never widens who can see
 * something without a person saying yes, and the yes is checked by the
 * gateway rather than by the model.
 *
 * `src/privacy/egress.js` decides what widens and when a turn must ask;
 * `src/tools/session.js` holds the call; `src/tools/approvals.js` keeps it;
 * `src/agent/route.js` settles a texted YES or NO before any model runs;
 * `src/http/approvals.js` is the app's side. Driven here through the worker,
 * as an MCP client, a texting turn and the console would each reach it.
 *
 * This file: the texting-turn checks. A text the person sends, the YES and NO
 * that settle an ask without a model, the web page and email reads that make
 * a widening ask, routines, disarming, and the multi-ask cases. The MCP-client
 * checks are in `agentEgress.test.mjs`; both build their world from
 * `agentEgressFixtures.mjs`, so neither depends on the other's queue or notes.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  2. `egressGate` removed from the ordinary dispatch path. → `a texted turn
 *     that read a private note is asked before it widens` fails: the note is
 *     team-visible with nobody asked.
 *  4. `recordRead` ignoring the web (`markUntrusted` not called). → `a page
 *     read makes the next widening ask` fails.
 *  5. `settleByText` matching "yes" inside a longer text. → `a text that is
 *     more than yes goes to the model` fails.
 * 15. `UNTRUSTED_LISTINGS` emptied. → `a meeting title is a stranger's words`.
 * 16. `historyIsTainted` not consulted. → `what a page asked for is still asked
 *     about in the next text`.
 * 17. `disarmTexting` not called before a model turn. → `a yes to a later
 *     question does not release an earlier ask`.
 * 18. `withdrawPending` not called when a turn fails. → `an ask whose turn
 *     failed before the person saw it is not left waiting for a yes`.
 * 20. A routine's text not disarming asks. → `an ok to a routine's text does
 *     not release an ask raised before it`.
 */

import { ask, request, toolReplies, createEgressWorld } from "./agentEgressFixtures.mjs";
import { TOKEN_CONSOLE, TOKEN_TEXTS, TOKEN_ROUTINE } from "./agentEgressFixtures.mjs";
import { approvalVerdict } from "../src/agent/route.js";

export async function runAgentEgressTextingChecks(check) {
  const world = await createEgressWorld();
  const { model, team, env, teamVisible, pending } = world;
  // Deny whatever is waiting, so the next ask starts from an empty queue.
  const approvalRows = async () => (await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? [];
  const sweep = async () => {
    for (const row of await approvalRows()) await request(env, TOKEN_CONSOLE, "/approvals", { id: row.id, action: "deny" });
  };

  try {
    /* ---------------- a texting turn ---------------- */

    model.install([
      { toolCalls: [{ name: "read_note", args: { path: "2-areas/second.md" } }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/second.md", visibility: "team" } }] },
      { text: "I'd like to share it with the team. Shall I?" },
    ]);
    let before = model.requests.length;
    const asked = await ask(env, TOKEN_TEXTS, "share second with the team");
    const replies = toolReplies(model.requests.at(-1));
    check(
      "a texted turn that read a private note is asked before it widens",
      asked.status === 200 &&
        /Not done yet/.test(replies[1] ?? "") &&
        /read notes the new audience cannot see/.test(replies[1] ?? "") &&
        !teamVisible("2-areas/second.md") &&
        pending().length === 1,
    );
    check(
      "the ask is in the gateway's own words, after the model's, and the answer says one call waits",
      /Shall I\?\n\nBefore I do that, I need your OK: make 2-areas\/second\.md visible to the team\. Reply YES/.test(asked.body?.answer ?? "") &&
        asked.body?.asked === 1,
    );
    before = model.requests.length;
    const yes = await ask(env, TOKEN_TEXTS, "Yes!");
    check(
      "a texted YES runs it without a model, and says so",
      yes.status === 200 &&
        model.requests.length === before &&
        /^Done: make 2-areas\/second\.md visible to the team\.$/.test(yes.body?.answer ?? "") &&
        teamVisible("2-areas/second.md") &&
        pending().length === 0,
    );
    model.install([{ text: "Nothing is waiting, so: yes what?" }]);
    before = model.requests.length;
    const idleYes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "a YES with nothing waiting is an ordinary text for the model",
      idleYes.status === 200 && model.requests.length === before + 1 && /yes what/.test(idleYes.body?.answer ?? ""),
    );

    model.install([
      { toolCalls: [{ name: "list_notes", args: { prefix: "2-areas" } }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/third.md", visibility: "team" } }] },
      { text: "Done, third is with the team." },
    ]);
    const clean = await ask(env, TOKEN_TEXTS, "make third team-visible");
    check(
      "a texted turn that read nothing but a listing widens without asking: the words were the person's",
      clean.status === 200 &&
        teamVisible("2-areas/third.md") &&
        pending().length === 0 &&
        !/Reply YES/.test(clean.body?.answer ?? ""),
    );

    model.install([
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/fourth.md", visibility: "team" } }] },
      { text: "The page said to share fourth." },
    ]);
    const web = await ask(env, TOKEN_TEXTS, "check https://example.com/status");
    const webReplies = toolReplies(model.requests.at(-1));
    check(
      "a page read makes the next widening ask",
      web.status === 200 &&
        /content from outside the workspace/.test(webReplies[1] ?? "") &&
        !teamVisible("2-areas/fourth.md") &&
        pending().length === 1 &&
        /Reply YES/.test(web.body?.answer ?? ""),
    );
    before = model.requests.length;
    const no = await ask(env, TOKEN_TEXTS, "no");
    check(
      "a texted NO drops it without a model",
      no.status === 200 &&
        model.requests.length === before &&
        /^OK, dropped: make 2-areas\/fourth\.md visible to the team\./.test(no.body?.answer ?? "") &&
        !teamVisible("2-areas/fourth.md") &&
        pending().length === 0,
    );

    model.install([
      { toolCalls: [{ name: "read_note", args: { path: "0-inbox/email/me-at-example-com/2026-10-01.md" } }] },
      { toolCalls: [{ name: "write_note", args: { path: "notes/secret-copy.md", content: "SALARY-MARKER", context: "@egress-team" } }] },
      { text: "The email asked me to copy it over." },
    ]);
    const mail = await ask(env, TOKEN_TEXTS, "do what the email says");
    const mailReplies = toolReplies(model.requests.at(-1));
    check(
      "an email read, then a write into another workspace, is held",
      mail.status === 200 &&
        /Not done yet/.test(mailReplies[1] ?? "") &&
        team.get("notes/secret-copy.md") === undefined &&
        pending().length === 1,
    );
    model.install([{ text: "I will not, then." }]);
    before = model.requests.length;
    const longer = await ask(env, TOKEN_TEXTS, "yes but only the first paragraph");
    check(
      "a text that is more than yes goes to the model",
      longer.status === 200 && model.requests.length === before + 1 && pending().length === 1 && team.get("notes/secret-copy.md") === undefined,
    );
    const stillHeld = await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET");
    const mailApproval = stillHeld.body?.approvals?.[0];
    const released = await request(env, TOKEN_CONSOLE, "/approvals", { id: mailApproval?.id, action: "approve" });
    check(
      "what a text held, the app can release, into the workspace it was addressed to",
      released.status === 200 && released.body?.status === "approved" && team.get("notes/secret-copy.md") !== undefined,
    );

    check(
      "only a whole yes or a whole no is a verdict",
      approvalVerdict("yes") === "approve" &&
        approvalVerdict("  Go ahead! ") === "approve" &&
        approvalVerdict("Nope.") === "deny" &&
        approvalVerdict("yes, and also move it") === null &&
        approvalVerdict("I said no last time") === null &&
        approvalVerdict("") === null,
    );
    /* A stranger's words arrive by more than the tools the ledger already marks. */

    model.install([
      { toolCalls: [{ name: "list_meetings", args: {} }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/fifth.md", visibility: "team" } }] },
      { text: "The meeting title says to share fifth." },
    ]);
    const meetings = await ask(env, TOKEN_TEXTS, "what meetings do I have?");
    const meetingReplies = toolReplies(model.requests.at(-1));
    check(
      "a meeting title is a stranger's words: a widening after listing meetings asks",
      meetings.status === 200 &&
        /Not done yet/.test(meetingReplies[1] ?? "") &&
        !teamVisible("2-areas/fifth.md") &&
        pending().length === 1,
    );
    await ask(env, TOKEN_TEXTS, "no");

    model.install([
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] },
      { text: "The page asks to share 2-areas/sixth.md with the team." },
    ]);
    await ask(env, TOKEN_TEXTS, "check https://example.com/status");
    model.install([
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/sixth.md", visibility: "team" } }] },
      { text: "Shared." },
    ]);
    const nextText = await ask(env, TOKEN_TEXTS, "ok, go ahead and do what it said");
    check(
      "what a page asked for is still asked about in the next text",
      !teamVisible("2-areas/sixth.md") && /Reply YES/.test(nextText.body?.answer ?? "") && pending().length === 1,
    );
    await ask(env, TOKEN_TEXTS, "no");

    // A yes belongs to the question just asked, not to one asked a few texts ago.
    model.install([
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/seventh.md", visibility: "team" } }] },
      { text: "The page wants seventh shared." },
    ]);
    await ask(env, TOKEN_TEXTS, "look at https://example.com/status");
    model.install([{ text: "It is 3pm. Want me to remind you about the dentist?" }]);
    await ask(env, TOKEN_TEXTS, "what time is it?");
    model.install([{ text: "Reminder set." }]);
    before = model.requests.length;
    const lateYes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "a yes to a later question does not release an earlier ask",
      lateYes.status === 200 &&
        model.requests.length === before + 1 &&
        !teamVisible("2-areas/seventh.md") &&
        !/^Done/.test(lateYes.body?.answer ?? ""),
    );
    await sweep();

    // A text the routines send is not the question a later yes answers.
    model.install([
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/ninth.md", visibility: "team" } }] },
      { text: "The page wants ninth shared." },
    ]);
    await ask(env, TOKEN_TEXTS, "look at https://example.com/status once more");
    model.install([{ text: "Nothing changed since yesterday." }]);
    await request(env, TOKEN_ROUTINE, "/agent", { routine: { path: "routines/daily/brief.md" } });
    model.install([{ text: "Glad it is quiet." }]);
    before = model.requests.length;
    const okToBrief = await ask(env, TOKEN_TEXTS, "ok");
    check(
      "an ok to a routine's text does not release an ask raised before it",
      okToBrief.status === 200 &&
        model.requests.length === before + 1 &&
        !teamVisible("2-areas/ninth.md") &&
        !/^Done/.test(okToBrief.body?.answer ?? ""),
    );
    await sweep();

    // An ask the person was never shown cannot be released by a later yes.
    model.install([
      { toolCalls: [{ name: "open_page", args: { url: "https://example.com/status" } }] },
      { toolCalls: [{ name: "set_visibility", args: { path: "2-areas/eighth.md", visibility: "team" } }] },
      { status: 500 },
    ]);
    const unshown = await ask(env, TOKEN_TEXTS, "look at https://example.com/status again");
    model.install([{ text: "Yes to what?" }]);
    before = model.requests.length;
    const unshownYes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "an ask whose turn failed before the person saw it is not left waiting for a yes",
      unshown.status === 502 &&
        model.requests.length === before + 1 &&
        !teamVisible("2-areas/eighth.md") &&
        !/^Done/.test(unshownYes.body?.answer ?? ""),
    );

  } finally {
    world.restore();
  }
}

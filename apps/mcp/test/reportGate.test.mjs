/**
 * THE BUG-REPORT GATE, END TO END: a bug report filed by text reaches the
 * Context team only on the person's YES to that exact report, and their texts
 * go with it only then (`src/tools/reportGate.js`).
 *
 * Driven through the worker on the egress checks' world
 * (`agentEgressFixtures.mjs`), whose control-plane stub records each
 * `/gateway/feedback` it accepts, texts included.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `report_problem` left out of `HELD_GATES`. → `a texted bug report is
 *     held, shown whole, and not sent` fails: it is sent at once.
 *  2. `report_problem` left out of `YES_ONLY` in `textedApprovals.js`. → `an
 *     "ok" to a bug report is not a yes` fails.
 *  3. `reportGate` reading the texts before the approved replay (sending them
 *     with the held call). → `nothing of the texts leaves before the YES`
 *     fails.
 *  4. `reportGate` sending at once whenever their text asks, texts or not
 *     (2026-10-21). → `…but their texts still go only on a yes` fails.
 */

import { reportCopy } from "../src/tools/reportGate.js";
import { ask, call, request, textOf, createEgressWorld, TOKEN_MCP, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const REPORT = { message: "Search found nothing for a note I know exists.", share_texts: true };
const report = (args) => ({ toolCalls: [{ name: "write", args: { action: "report_problem", args } }] });

export async function runReportGateChecks(check) {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  const sent = () => controlPlane.feedback;

  try {
    // Something to report about, in the conversation the texts come from.
    model.install([{ text: "I couldn't find a note about avocados." }]);
    await ask(env, TOKEN_TEXTS, "find my avocado note");

    model.install([report(REPORT), { text: "I wrote it up." }]);
    const asked = await ask(env, TOKEN_TEXTS, "that's a bug, can you file it");
    check(
      "a texted bug report is held, shown whole, and not sent",
      asked.status === 200 &&
        sent().length === 0 &&
        pending().length === 1 &&
        Array.isArray(asked.body?.verbatim) &&
        asked.body.verbatim[0] ===
          "Here's the bug report I'd send to the Context team:\n\n" +
            "Search found nothing for a note I know exists.\n\n" +
            "Up to the last 12 messages between us go with it, so they can see what happened.\n\n" +
            "Look good? Give this a 👍 or say yes and I'll send it.",
    );
    check("nothing of the texts leaves before the YES", sent().length === 0 && !JSON.stringify(sent()).includes("avocado"));

    let before = model.requests.length;
    model.install([{ text: "OK." }]);
    await ask(env, TOKEN_TEXTS, "ok");
    model.install([{ text: "Yes what?" }]);
    await ask(env, TOKEN_TEXTS, "yes");
    check("an \"ok\" to a bug report is not a yes", sent().length === 0 && model.requests.length > before);

    model.install([report(REPORT), { text: "Here it is again." }]);
    await ask(env, TOKEN_TEXTS, "file that bug please");
    before = model.requests.length;
    const yes = await ask(env, TOKEN_TEXTS, "YES");
    const filed = sent()[0];
    check(
      "a texted YES sends exactly that report with their recent texts, without a model",
      model.requests.length === before &&
        sent().length === 1 &&
        filed.accessToken === TOKEN_TEXTS &&
        filed.message === REPORT.message &&
        typeof filed.texts === "string" &&
        filed.texts.includes("Them: find my avocado note") &&
        filed.texts.includes("Tex: I couldn't find a note about avocados.") &&
        yes.body?.answer === "Done, I sent a bug report to the Context team.",
    );

    model.install([report({ message: "The link in your last text did not open." }), { text: "Written up." }]);
    const plain = await ask(env, TOKEN_TEXTS, "report the broken link, but don't send our chat");
    check(
      "a report without texts says so, and its YES sends the message alone",
      /None of our texts go with it\./.test(plain.body?.verbatim?.[0] ?? "") && sent().length === 1,
    );
    await ask(env, TOKEN_TEXTS, "yes");
    check("…and its YES sends the message alone", sent().length === 2 && sent()[1].texts === undefined);

    model.install([report({ message: "Something else broke." }), { text: "Written up." }]);
    await ask(env, TOKEN_TEXTS, "file another one");
    await ask(env, TOKEN_TEXTS, "no");
    check("a NO drops it", sent().length === 2);

    // Dev2, 2026-10-21: a 👍 that stayed on the ask is the yes, but only on the ask for what is waiting.
    const like = (words) => request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: words, tapback: "Liked", conversation: "texts" });
    model.install([report({ message: "Thumbs should work." }), { text: "Written up." }]);
    const shown = (await ask(env, TOKEN_TEXTS, "file a thumbs one")).body?.verbatim?.[0] ?? "";
    model.install([{ text: "Glad you like it." }]);
    await like("Here's the bug report I'd send to the Context team:\n\nSomething else broke.\n\nNone of our texts go with it.");
    check("a 👍 on an older ask releases nothing", sent().length === 2);
    model.install([report({ message: "Thumbs should work." }), { text: "Written up." }]);
    await ask(env, TOKEN_TEXTS, "file a thumbs one");
    before = model.requests.length;
    const liked = await like(`${shown.slice(0, 60)}…`);
    check(
      "a 👍 on the ask for what is waiting sends it, without a model",
      model.requests.length === before && sent().length === 3 && sent()[2].message === "Thumbs should work." && liked.body?.answer === "Done, I sent a bug report to the Context team.",
    );

    const mcpShares = await call(env, TOKEN_MCP, "report_problem", { message: "read_note timed out", share_texts: true });
    const routineShares = await call(env, TOKEN_ROUTINE, "report_problem", { message: "a routine failed", share_texts: true });
    check(
      "no other AI may attach texts",
      mcpShares.isError === true && /only for a report the person files by text/.test(textOf(mcpShares)) && routineShares.isError === true && sent().length === 3,
    );
    const mcp = await call(env, TOKEN_MCP, "report_problem", { message: "read_note timed out" });
    check(
      "another AI's report goes as it always has: at once, the message alone",
      mcp.isError !== true && sent().length === 4 && sent()[3].message === "read_note timed out" && sent()[3].texts === undefined,
    );

    model.install([report({ message: "x".repeat(2_001), share_texts: true }), { text: "Too long." }]);
    const pendingBefore = pending().length;
    await ask(env, TOKEN_TEXTS, "file a long one");
    check("a report too long to read in one text is never put to the person", pending().length === pendingBefore && sent().length === 4);

    // Dev2, 2026-10-21: "do it for me, and if you can't do it, file a bug to the developers" was answered with a draft and a wait for 👍.
    const asks = "??? I told you to do it, don't add it to my todo list, do it for me, and if you can't do it, file a bug to the developers to give you the capability you need";
    model.install([report({ message: "Tex can't forward an email with its attachment." }), { text: "Filed it." }]);
    const pendingAsked = pending().length;
    const filedNow = await ask(env, TOKEN_TEXTS, asks);
    check(
      "a text that asks for a bug to be filed is the yes for a report without their texts: sent at once, nothing held",
      filedNow.status === 200 && sent().length === 5 && sent()[4].message === "Tex can't forward an email with its attachment." &&
        sent()[4].texts === undefined && pending().length === pendingAsked && filedNow.body?.verbatim === undefined,
    );
    model.install([report({ message: "Tex can't forward with attachments.", share_texts: true }), { text: "Wrote it up." }]);
    await ask(env, TOKEN_TEXTS, asks);
    check("…but their texts still go only on a yes to the report that says so", sent().length === 5 && pending().length === pendingAsked + 1);
  } finally {
    world.restore();
  }

  // The group chat of 2026-10-21: a model that had read an earlier copy wrote the line itself, and it was shown twice.
  const copied = reportCopy("Bubbles leave the thread. None of our texts go with it.\n\nNone of our texts go with it.", false);
  check(
    "the line about texts is said once, however often the model copied it",
    copied === "Bubbles leave the thread.\n\nNone of our texts go with it." &&
      reportCopy("Bubbles leave the thread.", true).endsWith("so they can see what happened.") &&
      !reportCopy("Bubbles. None of our texts go with it.", true).includes("None of our texts"),
  );
}

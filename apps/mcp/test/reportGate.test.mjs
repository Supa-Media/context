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
 */

import { ask, call, textOf, createEgressWorld, TOKEN_MCP, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

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
            "Reply YES to send it, or NO to drop it.",
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

    const mcpShares = await call(env, TOKEN_MCP, "report_problem", { message: "read_note timed out", share_texts: true });
    const routineShares = await call(env, TOKEN_ROUTINE, "report_problem", { message: "a routine failed", share_texts: true });
    check(
      "no other AI may attach texts",
      mcpShares.isError === true && /only for a report the person files by text/.test(textOf(mcpShares)) && routineShares.isError === true && sent().length === 2,
    );
    const mcp = await call(env, TOKEN_MCP, "report_problem", { message: "read_note timed out" });
    check(
      "another AI's report goes as it always has: at once, the message alone",
      mcp.isError !== true && sent().length === 3 && sent()[2].message === "read_note timed out" && sent()[2].texts === undefined,
    );

    model.install([report({ message: "x".repeat(2_001), share_texts: true }), { text: "Too long." }]);
    const pendingBefore = pending().length;
    await ask(env, TOKEN_TEXTS, "file a long one");
    check("a report too long to read in one text is never put to the person", pending().length === pendingBefore && sent().length === 3);
  } finally {
    world.restore();
  }
}

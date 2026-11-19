import assert from "node:assert/strict";
import { sixToolsOver } from "../../../src/agent/sixTools.js";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { EVERYWHERE_NOTICE } from "../../../src/agent/searchClaims.js";
import { oneToOne } from "../chats.mjs";
import { wordsOf } from "../../../../../scripts/tex-prompt-module.mjs";

const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: "object", properties: {} } });
const searchOf = (names) => sixToolsOver(names.map(tool)).tools.find((t) => t.name === "search");

/** The round's tool results, read from the last request, which carries the whole turn so far (`parallel-mail-searches.mjs`). */
const resultsOf = (requests) =>
  (requests.at(-1)?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content ?? ""));

export default {
  id: "search-names-google-chat",
  incident: "2026-11-19 (Training trial-hire): asked \"you can see the feedback we sent right?\", Tex searched notes and Gmail, answered from an email, and never read the Google Chat message that held the feedback; asked to end a trial \"I told him at the start it was a 2 week trial\", it repeated the claim as settled without looking it up. 2026-11-19 (a guild reading list, invented here): a fallback model searched with the workspace nested inside args, and the gateway refused it, so three searches never ran; then a background job answered \"a search across all your workspaces didn't turn one up\" after searches that each named one workspace.",
  cause: "search covers notes and mail but not Google Chat, which only fetch chat: reads, and nothing told Tex so; the reply check listed only notes, mail and earlier texts as the record to check a claim against, and never asked it to say what rests only on the person's memory; Tex's six-tool resolver passed a workspace written inside a search's args on to the gateway, which refuses it there, and nothing checked a claim of an every-workspace search against the calls that ran. Since the owner's 2026-11-19 decision a workspace a search names is a boost, never a fence: the 1:1 search covers every workspace the person reaches and says which ones it covered on its last line, and only \"only in @x\" keeps a search to one workspace.",
  path: "one-to-one text; a background job part that claims every workspace",
  // Sabotage (2026-11-19): drop the `chat` line in sixTools.js searchTool, or put rules.md item 8 back, and this fails.
  async run() {
    const own = searchOf(["search_notes", "read_note", "read_google_chat"]);
    assert.match(own.description, /Google Chat is not in this search/, "a turn that reads their Chat is told search does not cover it");
    assert.match(own.description, /fetch id "chat:"/, "and how to read it");
    const group = searchOf(["search_notes", "read_note", "earlier_chat"]);
    assert.doesNotMatch(group.description, /Google Chat/, "a group turn, which never reads their Chat, is not told to");
    const rules = wordsOf().rules;
    assert.match(rules, /their Google Chat, their calendar/, "a claim is checked in every place that could hold it");
    assert.match(rules, /what rests only on their memory/, "and what the record does not back is said as such");
    const chat = await oneToOne();
    try {
      // A 1:1 text: the workspace nested inside args is moved out of the call and boosted (`sixTools.js`), so the search runs
      // over every workspace the person reaches, with `boost: "@guild"` beside its words and no `context` to fence it.
      const turn = await chat.text("what's on the guild reading list?", [
        { toolCalls: [{ name: "search", args: { query: "reading list", args: { context: "@guild" } } }] },
        { text: "Nothing on the guild reading list." },
      ]);
      assert.equal(turn.answer, "Nothing on the guild reading list.");
      const results = resultsOf(chat.world.model.requests);
      assert.equal(results.length, 1, "the search was answered");
      assert.ok(results.every((text) => !/goes beside args/.test(text)), "the nested workspace was not refused");
      const { entries } = await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT);
      const reply = entries.find((entry) => entry.kind === "reply");
      assert.ok((reply?.timing?.tools ?? []).some((tool) => tool.name === "search_notes"), "the nested search ran as search_notes");
      // What the gateway ran, as the ledger kept it: no workspace fenced the search, and the named one only boosts it.
      const ran = entries.filter((entry) => entry.kind === "tool" && entry.name === "search_notes");
      assert.equal(ran.length, 1, "one search ran");
      assert.deepEqual(ran[0].args, { query: "reading list", boost: "@guild" }, "no context: every workspace is searched, @guild ranked first");
      // This world's person reaches two workspaces (`agentEgressFixtures.mjs`: her own and the team's), so the result ends with
      // the line saying which ones it covered. "@guild" is not one of them here, so nothing is boosted; the line is still there.
      const last = String(results[0] ?? "").trim().split(/\n\s*\n/).at(-1) ?? "";
      assert.match(last, /^Searched: @egress, @egress-team\.$/m, "the result's last line names every workspace it covered");

      // A background job's part: its searches named one workspace, and its answer claims it searched every one. The
      // notice goes back in a second round, and the answer that follows is the one kept (`claimCheck.js`, `searchClaims.js`).
      // A 1:1 text on the front door gives no reply checks (`front-door.md`), so the claim is checked on a job's part.
      const job = { id: "job-replay-00003", title: "Guild reading list", brief: "Find the guild reading list", attempt: 1, followUps: [] };
      const part = await chat.jobPart("find the guild reading list", job, [
        // "only in @guild": the person's own word for one workspace, so the search really is scoped and the claim is false.
        { toolCalls: [{ name: "search", args: { query: "reading list", context: "@guild", args: { only: true } } }] },
        { text: "I searched all your workspaces and found nothing." },
        { text: "Nothing on the guild reading list in the workspace I searched." },
      ]);
      assert.equal(part.answer, "Nothing on the guild reading list in the workspace I searched.");
      assert.ok(part.shown.includes(EVERYWHERE_NOTICE), "the second round carries the notice, not the claim going out");
    } finally {
      chat.restore();
    }
  },
};

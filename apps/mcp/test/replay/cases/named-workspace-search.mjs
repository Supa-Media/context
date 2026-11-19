import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { EVERYWHERE_NOTICE } from "../../../src/agent/searchClaims.js";
import { oneToOne } from "../chats.mjs";

/** The round's tool results, read from the last request, which carries the whole turn so far (`parallel-mail-searches.mjs`). */
const resultsOf = (requests) =>
  (requests.at(-1)?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content ?? ""));

/**
 * Invented words: a person asks what is on "the guild reading list", and the workspace is "@guild".
 */
export default {
  id: "named-workspace-search",
  incident:
    "2026-11-19 (a guild reading list, invented here): a fallback model searched with the workspace nested inside args, and the gateway refused it, so three searches never ran; then a background job answered \"a search across all your workspaces didn't turn one up\" after searches that each named one workspace.",
  cause:
    "Tex's six-tool resolver passed a workspace written inside a search's args on to the gateway, which refuses it there; and nothing checked a job's claim of an every-workspace search against the calls that ran.",
  path: "1:1 text that searches a named workspace; a background job part that claims every workspace",
  async run() {
    const chat = await oneToOne();
    try {
      // A 1:1 text: the workspace nested inside args is moved to the top of the call (`sixTools.js`), so the search runs.
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

      // A background job's part: its searches named one workspace, and its answer claims it searched every one. The
      // notice goes back in a second round, and the answer that follows is the one kept (`claimCheck.js`, `searchClaims.js`).
      // A 1:1 text on the front door gives no reply checks (`front-door.md`), so the claim is checked on a job's part.
      const job = { id: "job-replay-00003", title: "Guild reading list", brief: "Find the guild reading list", attempt: 1, followUps: [] };
      const part = await chat.jobPart("find the guild reading list", job, [
        { toolCalls: [{ name: "search_notes", args: { query: "reading list", context: "@guild" } }] },
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

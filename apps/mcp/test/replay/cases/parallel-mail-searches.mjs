import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../../../packages/tex/gateway/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

/**
 * One hit per search, named by the query, so the follow-up the model reads
 * shows which result landed in which slot.
 */
function hit(query) {
  return [{ address: "ada@example.com", id: "m1", threadId: "m1", date: "2026-11-17", from: "Ada <ada@example.com>", subject: query, snippet: "the invoice" }];
}

export default {
  id: "parallel-mail-searches",
  incident: "2026-11-17: a turn that searched two Gmail accounts ran the searches one after the other, so the reply waited out the sum.",
  cause: "A front-door round ran every tool call in order, including reads that share nothing: no browser, no write, no held yes.",
  path: "1:1 text that searches two mailboxes in one round",
  async run() {
    const chat = await oneToOne();
    const previous = globalThis.fetch;
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input?.url ?? "");
      if (url.includes("/gateway/email/search")) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 80));
        active -= 1;
      }
      return previous(input, init);
    };
    try {
      chat.world.controlPlane.flags.mailResults = (query) => hit(query);
      chat.world.controlPlane.flags.mailboxes = [
        { address: "one@example.com", folder: "0-inbox/email" },
        { address: "two@example.com", folder: "0-inbox/email" },
      ];
      const turn = await chat.text("anything in either mailbox about the invoice?", [
        {
          toolCalls: [
            { name: "search", args: { query: "alpha-invoice", args: { email: true, account: "one@example.com" } } },
            { name: "search", args: { query: "beta-invoice", args: { email: true, account: "two@example.com" } } },
          ],
        },
        { text: "Nothing that matches." },
      ]);
      assert.equal(maxActive, 2, "the two mailbox searches ran together");
      assert.equal(turn.answer, "Nothing that matches.");
      const followUp = chat.world.model.requests.at(-1);
      const results = (followUp?.messages ?? [])
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block?.type === "tool_result")
        .map((block) => String(block.content ?? ""));
      assert.equal(results.length, 2, "both searches were answered");
      assert.match(results[0], /alpha-invoice/);
      assert.match(results[1], /beta-invoice/);
      const { entries } = await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT);
      const reply = entries.find((entry) => entry.kind === "reply");
      const searches = (reply?.timing?.tools ?? []).filter((tool) => tool.name === "search_email");
      assert.equal(searches.length, 2);
      assert.ok(Math.abs(searches[1].at - searches[0].at) < 40, `searches started ${Math.abs(searches[1].at - searches[0].at)}ms apart`);
      assert.ok(searches.every((tool) => tool.ms >= 60), "each search still took its own time");
    } finally {
      globalThis.fetch = previous;
      chat.restore();
    }
  },
};

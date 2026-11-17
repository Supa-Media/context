import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

/**
 * One hit, so the search the model reads is the mailbox it asked about.
 * @param {string} query
 */
function hit(query) {
  return [{ address: "ada@example.com", id: "m1", threadId: "m1", date: "2026-11-17", from: "Ada <ada@example.com>", subject: query, snippet: "the invoice" }];
}

export default {
  id: "serial-vault-fetch",
  incident: "2026-11-17: a turn that searched a mailbox and called a shop's API with a saved key ran the two at once, so the call could land before the search it depended on.",
  cause: "send api resolves to vault_list with fetch, and the parallel-read check looked at the name only, so that outbound call ran beside a read.",
  path: "1:1 text that searches one mailbox and calls an API with a saved key in the same round",
  async run() {
    const chat = await oneToOne();
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input?.url ?? "");
      if (url.includes("/gateway/email/search")) await new Promise((resolve) => setTimeout(resolve, 120));
      return previous(input, init);
    };
    try {
      chat.world.controlPlane.flags.mailResults = (query) => hit(query);
      chat.world.controlPlane.flags.mailboxes = [{ address: "ada@example.com", folder: "0-inbox/email" }];
      const turn = await chat.text("anything from Ada about the invoice, and post a note of it to the shop?", [
        {
          toolCalls: [
            { name: "search", args: { query: "alpha-invoice", args: { email: true, account: "ada@example.com" } } },
            {
              name: "send",
              args: {
                action: "api",
                args: { entry: "v0123456789abcdef01234567", field: "API_KEY", url: "https://api.example.com/v1/items", method: "POST" },
              },
            },
          ],
        },
        { text: "Ada's note is in. The shop call did not go through." },
      ]);
      assert.equal(turn.answer, "Ada's note is in. The shop call did not go through.");
      const { entries } = await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT);
      const reply = entries.find((entry) => entry.kind === "reply");
      const tools = reply?.timing?.tools ?? [];
      const search = tools.find((tool) => tool.name === "search_email");
      const api = tools.find((tool) => tool.name === "vault_list");
      assert.ok(search, `no mailbox search in ${JSON.stringify(tools)}`);
      assert.ok(api, `no vault fetch in ${JSON.stringify(tools)}`);
      assert.ok(search.ms >= 80, `the search was not slowed (${search.ms}ms)`);
      const gap = api.at - search.at;
      // Serial: the api call starts when the search finishes. Together: it starts with the search.
      assert.ok(gap >= search.ms - 40, `the api call started ${gap}ms after the search, which took ${search.ms}ms`);
    } finally {
      globalThis.fetch = previous;
      chat.restore();
    }
  },
};

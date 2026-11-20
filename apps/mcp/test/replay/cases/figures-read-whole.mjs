import assert from "node:assert/strict";
import { untriedWebCheck } from "../../../../../packages/tex/gateway/agent/untriedWeb.js";

export default {
  id: "figures-read-whole",
  incident: "2026-11-09 to 11-15: the reply reviewer sent back a 1:1 reply quoting a 23 s reply time from the ledger, saying the read showed only a header; another, quoting a film's ratings, it judged by the search words rather than the results. Both rewrites dropped true facts.",
  cause: "The reviewer saw each tool result cut to 16K characters and judged from a summary of the turn; a chat turn's rewrite is not reviewed again, so a wrong send-back shipped a worse reply. Dev2 chose a code figure check over everything the model saw, and the reviewer only on job reports and scheduled texts.",
  path: "1:1 text",
  async run() {
    assert.equal(untriedWebCheck().check("Lately the median reply takes 23 s, and 96% go out under a minute.", turn("median 23 s; under a minute 96%")), null, "a figure deep in a long read is sourced");
    const notice = untriedWebCheck().check("Lately the median reply takes 23 s, and 64% go out under a minute.", turn("median 23 s; under a minute 96%"));
    assert.match(String(notice), /64%/, "a figure in nothing read goes back, named");
  },
};

/** A turn that read a long ledger and quoted a figure from past its first 16K characters. */
const turn = (tail) => ({
  messages: [
    { role: "user", text: "how long do your replies take lately?" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "fetch", args: { path: "tex/history.ledger.json" } }] },
    { role: "tool", id: "c1", name: "fetch", text: `${"{\"kind\":\"text\"}\n".repeat(3_000)}${tail}` },
  ],
  system: "You are Tex.",
});

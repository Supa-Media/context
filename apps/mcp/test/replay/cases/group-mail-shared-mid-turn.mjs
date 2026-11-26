import assert from "node:assert/strict";
import { commandTools } from "../../../../../packages/tex/gateway/agent/commandTools.js";
import { askerMailOf, chatMailPrompt, mailOnShare } from "../../../../../packages/tex/gateway/agent/groupMail.js";
import { sixToolsOver } from "../../../../../packages/tex/gateway/agent/sixTools.js";

export default {
  id: "group-mail-shared-mid-turn",
  incident: "2026-11-26, everyday-groups bench (the Puttery ask): asked in a group to email a venue in its booking thread, Tex shared the asker's Gmail, found no tool to search it, and told her to text it one-to-one; in other runs it asked which Gmail address was hers.",
  cause: "A turn's tools were fixed when it started, so mail shared partway through it could not be read until the next text; and the group turn was never told the asker's own connected Gmails.",
  path: "group tag",
  async run() {
    const group = { from: "lena", askerMail: askerMailOf(["lena@example.invalid"]) };
    assert.match(chatMailPrompt(group), /lena@example\.invalid/, "the asker's own Gmail is named, so no address question is needed");
    const later = mailOnShare(group, []);
    const share = commandTools({ run: async (command) => ({ status: "done", address: command.address }), group: { key: "k", from: "lena" }, consent: async () => true, onShareMail: later.shared }).find((entry) => entry.tool.name === "chat_share_mail");
    const said = (await share.call({ address: "lena@example.invalid" })).content.map((part) => part.text).join("");
    assert.match(said, /readable_this_turn/, "the share says it can be read now");
    const granted = later.take();
    assert.deepEqual(granted.map((tool) => tool.name).sort(), ["read_email", "search_email"], "the share grants its reads to this turn");
    const six = sixToolsOver([]);
    for (const tool of granted) six.hold(tool);
    assert.equal(six.resolve("fetch", { id: "email:lena@example.invalid/19b2putt0001" }).name, "read_email", "after it, the same turn reads the thread");
  },
};

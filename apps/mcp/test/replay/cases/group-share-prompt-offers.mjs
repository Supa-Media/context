import assert from "node:assert/strict";
import { commandTools } from "../../../../../packages/tex/gateway/agent/commandTools.js";
import { askerMailOf, chatMailPrompt, mailOnShare } from "../../../../../packages/tex/gateway/agent/groupMail.js";
import { sixToolsOver } from "../../../../../packages/tex/gateway/agent/sixTools.js";
import { chatCalendarPrompt } from "../../../../../packages/tex/gateway/agent/groupCalendar.js";

export default {
  id: "group-share-prompt-offers",
  incident: "2026-11-22, Lab copy of Tex Devs after the capability fix: asked whether seeing their mail would help, Tex still told the member to type \"Tex, share my mail from your address here\".",
  cause: "The group turn's mail line (the one the turn actually reads, unlike the capability list, which the group front door is not given) told Tex the set phrase to hand out, and the calendar lines never said a yes to Tex's offer is enough.",
  path: "group tag",
  async run() {
    const mail = chatMailPrompt({ mail: [] });
    assert.doesNotMatch(mail, /by typing/, "no phrase to dictate");
    assert.match(mail, /plain yes to your offer is enough: never tell them to type a set phrase/);
    assert.match(chatCalendarPrompt({ calendar: [] }), /plain yes to your offer is enough: never tell them to type a set phrase/);
    assert.match(chatCalendarPrompt({ calendar: [{ handle: "ada", address: "ada@example.com" }] }), /share theirs by asking you \(send action chat_share_calendar\): offer it/, "and with some calendars shared, the others can still be offered");
    // 2026-11-25, Crystal Care: the asker had the shared work mailbox connected too; told only whose share it was, Tex
    // offered the reply for the sharer's yes, which the gate refused. The line now names it as the asker's to send from.
    const shared = chatMailPrompt({ from: "bo", mail: [{ handle: "ada", address: "ada@work.example", askerSends: true }] });
    assert.match(shared, /@ada's ada@work\.example \(connected to @bo too\)/);
    assert.match(shared, /connected to the asker goes as them, with from set and no as/);
    assert.doesNotMatch(chatMailPrompt({ from: "bo", mail: [{ handle: "ada", address: "ada@work.example" }] }), /connected to @bo/);
    // 2026-11-26, everyday-groups bench (the Puttery ask): asked in a group to email a venue in its booking thread, Tex
    // shared the asker's Gmail, found no tool to search it (a turn's tools were fixed when it started), and told her to
    // text it one-to-one; in other runs it asked which Gmail was hers, never told the asker's own connected Gmails.
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

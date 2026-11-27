import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

const JO = "jo.marsh@example.com";
const EMAIL = { to: [JO], subject: "Saturday", body: "Hi Jo,\n\nSaturday at 2 works for the band.\n\nAda" };
const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });

export default {
  id: "group-checker-knows-tagger",
  incident:
    "2026-11-27 (a Lab test chat of a group): Tex drafted an email and asked the tagger for a 👍; the tagger texted \"draft is good. go ahead\", the Mail checker said the go-ahead came from \"an unlabeled line\", and the email was held and asked for again.",
  cause:
    "The checker reads a group's kept turns as \"PERSON: @handle: ...\" but the newest text as a bare \"PERSON: ...\", so it could not tell the tagger's own go-ahead from anyone's.",
  path: "group chats that send email",
  async run() {
    const chat = await groupChat();
    try {
      chat.controlPlane.flags.emailSender = "ada@gmail.example";
      const asked = await chat.tag("ada", "@tex email jo that saturday at 2 works", [
        { toolCalls: [{ name: "send_email", args: EMAIL }] },
        verdict("yes", "the tagger asked for it"),
        { text: "Sent it to Jo." },
        { text: "Sent it to Jo." },
      ], [], { tagged: true, group: { people: ["ada", "bo"], cause: "tagged" }, body: { running: [] } });
      const checker = asked.requests.map((request) => JSON.stringify(request?.messages ?? [])).find((text) => text.includes("TEXTS") && text.includes("DRAFT"));
      assert.ok(checker, "the Mail checker ran");
      assert.match(checker, /PERSON: @ada: @tex email jo that saturday at 2 works/, "the newest text carries its tagger's handle");
    } finally {
      chat.restore();
    }
  },
};

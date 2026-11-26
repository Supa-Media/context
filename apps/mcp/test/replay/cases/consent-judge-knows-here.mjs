import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

/** The text of one model request's first user message (the judge's whole question). */
const firstText = (request) => {
  const message = request?.messages?.[0];
  const content = Array.isArray(message?.content) ? message.content : [{ text: message?.content }];
  return content.map((block) => block?.text ?? "").join("");
};

export default {
  id: "consent-judge-knows-here",
  incident: "2026-11-19 and 2026-11-22: in group chats, \"Tex, share my calendar here too\" and a new member's first asks to share their calendar were refused as not their own words; one went through only on a later try, and Tex guessed the calendar address was the problem.",
  cause: "The consent judge was shown only the one text and a one-line action, so it never knew \"here\" was the group chat the text was sent in, and the turn was never told the judge's reason; a bare yes to Tex's own offer never reached the judge, stopped by the code word check. And (2026-11-26) the judge was never told whose Gmail \"my gmail\" is, so a member's own share was refused as not the inbox owner's.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    const sent = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input?.url ?? "");
      if (url.endsWith("/gateway/tex/command")) {
        const { command } = JSON.parse(init.body);
        sent.push(command);
        return new Response(JSON.stringify({ status: "done", addresses: ["bo@example.com"] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return previous(input, init);
    };
    try {
      const shared = await chat.tag(
        "bo",
        "Tex, share my calendar here too",
        [
          { toolCalls: [{ name: "chat_share_calendar", args: {} }] },
          { toolCalls: [{ name: "verdict", args: { allow: true, reason: "asks to share their calendar with this chat" } }] },
          { text: "Shared bo@example.com here." },
        ],
        [],
        { group: { people: ["ada", "bo"], names: [{ handle: "ada", name: "Ada" }] } },
      );
      const judged = shared.requests.find((request) => /<person_said>/.test(firstText(request)));
      assert.ok(judged, "the consent judge is asked");
      const question = firstText(judged);
      assert.match(question, /<chat>The words were texted by @bo in a group text chat with Tex, with @ada \(Ada\)\./, "it is told which chat the words were sent in, and who is in it");
      assert.match(question, /"Here", "this chat"[^<]*mean this group chat and its people/, "and that \"here\" means that chat");
      assert.deepEqual(sent.at(-1), { kind: "share_calendar" }, "the share is asked of the control plane");

      const refused = await chat.tag(
        "bo",
        "Tex, the calendar thing",
        [
          { toolCalls: [{ name: "chat_share_calendar", args: {} }] },
          { toolCalls: [{ name: "verdict", args: { allow: false, reason: "It names the calendar but does not ask to share it." } }] },
          { text: "Want me to share your calendar with this chat? Say yes." },
        ],
        [],
        { group: { people: ["ada", "bo"] } },
      );
      const results = (refused.requests.at(-1)?.messages ?? [])
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block?.type === "tool_result")
        .map((block) => String(block.content ?? ""));
      assert.match(results.join("\n"), /The check's reason: It names the calendar but does not ask to share it\./, "a refusal hands the turn the judge's reason");
      const judgedAgain = refused.requests.find((request) => /<person_said>/.test(firstText(request)));
      assert.match(firstText(judgedAgain), /<assistant_said>Shared bo@example\.com here\.<\/assistant_said>/, "and the judge sees Tex's last text in the chat");

      sent.length = 0;
      const yes = await chat.tag(
        "bo",
        "Tex yeah go ahead",
        [
          { toolCalls: [{ name: "chat_share_calendar", args: {} }] },
          { toolCalls: [{ name: "verdict", args: { allow: true, reason: "agrees to the assistant's offer to share their calendar here" } }] },
          { text: "Shared bo@example.com here." },
        ],
        [],
        { group: { people: ["ada", "bo"] } },
      );
      const judgedYes = yes.requests.find((request) => /<person_said>/.test(firstText(request)));
      assert.ok(judgedYes, "a yes to Tex's own offer reaches the judge, though it names no calendar");
      assert.match(firstText(judgedYes), /<assistant_said>Want me to share your calendar with this chat\? Say yes\.<\/assistant_said>/, "with the offer it answers");
      assert.deepEqual(sent.at(-1), { kind: "share_calendar" }, "and the share goes through");

      // 2026-11-26, everyday-groups bench (the Puttery ask): "share my gmail here" from @lena was refused as "the words
      // are from @lena, not the inbox owner". The judge is now told the sender's own connected Gmails.
      const mail = await chat.tag(
        "bo",
        "Tex share my gmail here",
        [
          { toolCalls: [{ name: "chat_share_mail", args: { address: "bo@example.com" } }] },
          { toolCalls: [{ name: "verdict", args: { allow: true, reason: "asks to share their own Gmail with this chat" } }] },
          { text: "Shared bo@example.com here." },
        ],
        [],
        { group: { people: ["ada", "bo"], askerMail: ["bo@example.com"] } },
      );
      const judgedMail = mail.requests.find((request) => /<person_said>/.test(firstText(request)));
      assert.ok(judgedMail, "the mail share is judged");
      assert.match(firstText(judgedMail), /<accounts>\{"sender":"@bo","senders_own_connected_gmail":\["bo@example\.com"\]\}<\/accounts>/, "and the judge knows whose inbox \"my gmail\" is");
      // gh-225: shown that, it still refused, writing allow:false before reasoning "so it does cover the action".
      const verdictTool = (judgedMail.tools ?? []).find((tool) => tool.name === "verdict");
      assert.deepEqual(Object.keys((verdictTool?.input_schema ?? verdictTool?.inputSchema ?? {}).properties ?? {}), ["reason", "allow"], "and it reasons before its verdict");
    } finally {
      globalThis.fetch = previous;
      chat.restore();
    }
  },
};

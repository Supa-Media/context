import assert from "node:assert/strict";
import { TEX_CONFIG, texToolList } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { oneToOne } from "../chats.mjs";

export default {
  id: "routine-sees-chat",
  incident: "2026-11-12: a check-in answered a text from the night before, because a turn that answers no named text read a thinner, separately built view of the chat than a reply did (one door, 2026-11-13).",
  cause: "A turn with no named text (routine, check-in, job report) read a different view of the chat than a reply.",
  path: "1:1 routine",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("my piano lesson moved to Friday at 5", "Got it, Friday at 5.");
      // A morning of small talk after it: the routine's own short list of last texts (eight lines) no longer reaches it.
      for (const [words, reply] of [["what's 18% of 64?", "11.52."], ["thanks", "Anytime."], ["is it raining?", "Light rain till noon."], ["ok umbrella then", "Good call."], ["what's a synonym for brisk", "Crisp."]]) {
        await chat.text(words, reply);
      }
      chat.wait(60 * 60_000);
      const brief = await chat.routine("routines/daily/brief.md", "Piano Friday at 5.");
      assert.match(brief.shown, /my piano lesson moved to Friday at 5/, "the routine is shown the chat a reply would be, the morning's first text included");
      assert.match(brief.shown, /Got it, Friday at 5\./, "and Tex's own reply to it");
      assert.match(brief.shown, /Crisp\./, "through the newest");
      assert.doesNotMatch(brief.shown, /gone stale|still want this routine/, "a routine that has not texted them yet has no standing to tell");
      // 2026-11-16: a routine nobody answers any more kept texting, told nothing of its standing however many runs went
      // unanswered. On the simpler graph (live since its promotion) Routine runs tells the Front door its standing on
      // every run (`routineEngagement.js`, through `runARoutine`), and once its last three texts went unanswered it is
      // told to ask whether they still want it: `routineAsRoutine.test.mjs` and `routineEngagement.test.mjs` cover the rest.
      for (let i = 1; i <= 3; i += 1) {
        chat.wait(24 * 60 * 60_000);
        const { shown } = await chat.routine("routines/daily/brief.md", "Piano Friday at 5.");
        assert.match(shown, new RegExp(`This routine has texted them ${i} times? that you can see\\. They have not answered or reacted to any of them\\.`), `run ${i + 1} is told how many of its texts went unanswered`);
        assert.match(shown, /gone stale/, `run ${i + 1} is told to judge whether it has gone stale`);
        if (i < 3) assert.doesNotMatch(shown, /still want this routine/, `run ${i + 1} does not ask yet`);
        else assert.match(shown, /still want this routine/, "after three texts with no answer, it asks whether they still want it");
      }
      // 2026-11-17 (Dev2, cross-chat asks, design N3ZawPjhhgYcNfHm7xWa37): another chat's answer is the same kind of
      // turn, one no text of theirs started (the Worker queues it by code, `packages/tex/worker/crossChat.ts`). It reads the
      // chat a reply would, is told the words are another chat's, and an ask from another chat is answered back to it,
      // never texted here.
      const back = await chat.byCode("is the Lab demo still Friday?", "Tex Devs says yes, Friday at 3 PM.", { event: "chat_answer", crossChat: { kind: "answer", id: "xabcdefghij0123", from: "Tex Devs", what: "is the Lab demo still Friday?", state: "answered", texts: ["Yes, Friday at 3 PM."] } });
      assert.match(back.shown, /my piano lesson moved to Friday at 5/, "an answer from another chat reads the chat a reply would");
      assert.match(back.shown, /Not a text from them\. Tex in Tex Devs answered the ask you sent it/, "and is told it came from that chat, not from them");
      assert.match(back.shown, /Friday at 3 PM/, "with what it said");
      assert.equal(back.answer, "Tex Devs says yes, Friday at 3 PM.", "and tells them");
      const asked = await chat.byCode("which hotel did I book?", "The Hoxton, Williamsburg.", { event: "chat_ask", crossChat: { kind: "ask", id: "xbbbbbbbbbb", from: "a group chat they're in", what: "which hotel did I book?", do: false } });
      assert.match(asked.shown, /THIS RUN ANSWERS ANOTHER CHAT/, "an ask from another chat knows its answer leaves this chat");
      assert.equal(asked.answer, "", "nothing is texted to them");
      assert.equal(asked.body.crossBack?.id, "xbbbbbbbbbb", "the answer goes back to the chat that asked");
      assert.deepEqual(asked.body.crossBack?.texts, ["The Hoxton, Williamsburg."]);
      // 2026-11-17 (Dev2's 1:1, "ask the chat ... to build Tex a body"): ask_chat was "no such action", because only the
      // front door's `groups` module read their group list. Now the wired gate reads it too, and the 1:1 can ask.
      const TEX_DEVS = { key: "d".repeat(64), name: "Tex Devs", people: ["seyi"], lastSeenAt: 1 };
      const below = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/gateway/agent/identity") && JSON.parse(init?.body ?? "{}").groups === true) return new Response(JSON.stringify({ groups: [TEX_DEVS] }), { status: 200, headers: { "Content-Type": "application/json" } });
        return below(input, init);
      };
      let offered = "";
      let prompt = "";
      try {
        const asking = await chat.byCode("ask Tex Devs to start building Tex a body", [
          (request) => {
            offered = JSON.stringify(request.tools ?? []);
            prompt = JSON.stringify([request.system, request.messages]);
            return { toolCalls: [{ name: "send", args: { action: "ask_chat", args: { chat: "Tex Devs", what: "Seyi would like you to start building Tex a body.", do: true } } }] };
          },
          { text: "Asked Tex Devs, I'll tell you what they say." },
        ], { covers: [], crossCounts: { hour: 0, day: 0, open: [] } });
        assert.match(offered, /ask_chat/, "a 1:1 is offered ask_chat on main's config");
        // Per turn, ask_chat's words name their groups; on the fixed list (`sixToolsFixed.js`) the tools are the same for
        // every 1:1, so the names come from the turn's own groups module instead.
        if (texToolList("fd", TEX_CONFIG) === "fixed") assert.match(prompt, /Tex Devs/, "and told which groups it can ask");
        else assert.match(offered, /Their groups: Tex Devs\./, "and told which groups it can ask");
        assert.equal(asking.body.crossAsks?.length, 1, "the ask leaves for the Worker to carry");
        assert.deepEqual(asking.body.crossAsks[0].to, { kind: "group", key: TEX_DEVS.key, name: "Tex Devs" });
        assert.equal(asking.body.crossAsks[0].do, true);
      } finally {
        globalThis.fetch = below;
      }
    } finally {
      chat.restore();
    }
  },
};

/**
 * `fetch chat:`: one Google Chat conversation the person named, read live
 * through the control plane (`src/tools/googleChatRead.js`), and the routing
 * to it (`src/tools/v2/searchFetch.js`). Who may read is the control plane's
 * (`apps/convex/__tests__/googleChatSpaceRead.test.ts`); this holds that the
 * gateway asks for exactly the one conversation named, says where every word
 * came from, and is shown only where mail and texts are.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-10-29).
 *
 *  1. `readChatRequest` passing any text as a space. → "only a space's id or
 *     one work email is asked for" fails.
 *  2. `read_google_chat` left out of `PRIVATE_TIER_ONLY_TOOLS`. → "is shown
 *     only where the person's mail is" fails.
 *  3. The quotation line dropped from the answer. → "both sides, oldest
 *     first, as a quotation" fails.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { translateFetch } from "../src/tools/v2/searchFetch.js";
import { CHAT_QUOTATION, MAX_CHAT_READ, readChatRequest, toolReadGoogleChat } from "../src/tools/googleChatRead.js";
import { createGoogleChatMethods } from "../src/controlPlane/googleChat.js";
import { PRIVATE_TIER_ONLY_TOOLS, toolDefinitions } from "../src/tools/registry.js";
import { UNTRUSTED_READS } from "../src/privacy/egress.js";

const CLAUDE = { client: "claude-code" };

function storeAnswering(answer) {
  const asked = [];
  return {
    asked,
    store: {
      googleChat: {
        conversation: async (request) => {
          asked.push(request);
          return answer;
        },
      },
    },
  };
}

describe("fetch chat:", () => {
  it("routes a space id, a person, and the list of spaces", () => {
    assert.deepEqual(translateFetch({ id: "chat:spaces/AAA", args: { limit: 5 } }, CLAUDE), {
      name: "read_google_chat",
      arguments: { space: "spaces/AAA", limit: 5 },
      action: "chat",
    });
    assert.deepEqual(translateFetch({ id: "chat:", args: { to: "amy@work.example" } }, CLAUDE), {
      name: "read_google_chat",
      arguments: { to: "amy@work.example" },
      action: "chat",
    });
    assert.deepEqual(translateFetch({ id: "chat:" }, CLAUDE), { name: "google_chat", arguments: { action: "spaces" }, action: "chat_spaces" });
    // ChatGPT's no-args shortcut reads notes only; a chat: id is routed as for everybody.
    assert.equal(translateFetch({ id: "chat:spaces/AAA" }, { client: "chatgpt" }).name, "read_google_chat");
    assert.match(translateFetch({ id: "chat:spaces/AAA", args: { text: "hi" } }, CLAUDE).error, /takes args: limit/);
  });

  it("only a space's id or one work email is asked for", async () => {
    for (const args of [{ space: "Venue planning" }, { space: "spaces/AAA", to: "a@b.example" }, {}, { to: "not an address" }, { space: "spaces/AAA", limit: MAX_CHAT_READ + 1 }]) {
      const { asked, store } = storeAnswering({ ok: true, from: "", place: { space: "x" }, messages: [] });
      const answer = await toolReadGoogleChat(store, args);
      assert.equal(answer.isError, true, JSON.stringify(args));
      assert.deepEqual(asked, [], JSON.stringify(args));
    }
    assert.deepEqual(readChatRequest({ to: " Amy@Work.example " }), { request: { to: "amy@work.example" } });
  });

  it("answers both sides, oldest first, as a quotation, with the person as you", async () => {
    const { asked, store } = storeAnswering({
      ok: true,
      from: "alice@work.example",
      place: { person: "amy@work.example" },
      messages: [
        { id: "spaces/DM1/messages/m1", from: "Amy", mine: false, at: "2026-10-23T12:00:00Z", text: "Any luck on\nthe venue search?" },
        { id: "spaces/DM1/messages/m2", from: "you", mine: true, at: "2026-10-23T12:01:00Z", text: "on it" },
      ],
    });
    const answer = await toolReadGoogleChat(store, { to: "amy@work.example", limit: 2 });
    assert.deepEqual(asked, [{ to: "amy@work.example", limit: 2 }]);
    const text = answer.content[0].text;
    assert.match(text, /^Google Chat, the direct message with amy@work\.example, from alice@work\.example's account/);
    assert.ok(text.includes(CHAT_QUOTATION));
    assert.match(text, /trust: untrusted/);
    assert.ok(text.indexOf("2026-10-23 12:00 UTC · Amy: Any luck on\n  the venue search?") < text.indexOf("2026-10-23 12:01 UTC · you: on it"));
  });

  it("says what each refusal means, and never reads another way", async () => {
    for (const [refused, words] of [
      ["not_allowed", /only their own personal workspace's, with private access/],
      ["ai_access_needed", /AI access isn't allowed yet/],
      ["person_not_found", /did not find a conversation with them by that address, which does not mean they have none.*read it by that id/s],
      ["space_not_found", /fetch chat: lists their spaces/],
      ["something new", /did not answer just now/],
    ]) {
      const { store } = storeAnswering({ ok: false, refused });
      const answer = await toolReadGoogleChat(store, { space: "spaces/AAA" });
      assert.equal(answer.isError, true);
      assert.match(answer.content[0].text, words);
    }
  });

  it("asks the control plane for the one conversation, and drops a malformed message", async () => {
    const posted = [];
    const methods = createGoogleChatMethods({
      post: async (path, body) => {
        posted.push({ path, body: JSON.parse(JSON.stringify(body)) });
        return { ok: true, from: "alice@work.example", place: { space: "Venue planning" }, messages: [{ id: "m", from: "Bo", at: "t", text: "hi" }, { id: 3 }] };
      },
    });
    const answer = await methods.googleChatConversation("token", "ws", { space: "spaces/AAA", limit: 5 });
    assert.deepEqual(posted, [{ path: "/gateway/chat/recent", body: { accessToken: "token", expectedWorkspaceId: "ws", space: "spaces/AAA", limit: 5 } }]);
    assert.equal(answer.messages.length, 1);
  });

  it("is shown only where the person's mail is, and marks the turn as read from somebody else", () => {
    assert.ok(PRIVATE_TIER_ONLY_TOOLS.has("read_google_chat"));
    assert.ok(UNTRUSTED_READS.has("read_google_chat"));
    const tool = toolDefinitions().find((definition) => definition.name === "read_google_chat");
    assert.equal(tool?.annotations?.readOnlyHint, true);
  });
});

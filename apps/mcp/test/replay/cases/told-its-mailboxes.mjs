import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "told-its-mailboxes",
  incident:
    "2026-11-14: one of a person's four Gmails failed every live search for an afternoon; Tex guessed which mailboxes it had from the results, wrote the address under the wrong name, and told the person its live search only reached another of their addresses.",
  cause: "Nothing told a turn which mailboxes the person has connected, or that one of them was not fine, so the model inferred both from one search's answer.",
  path: "1:1 texts that search mail",
  async run() {
    const chat = await oneToOne();
    try {
      chat.world.controlPlane.dreams.mailHealth.mailboxes.set("ws_egress", [
        { address: "rowan@work.example", state: "ok", lastSyncedAt: Date.now(), tell: false, readOnly: false },
        { address: "rowan.home@mail.example", state: "stale", lastSyncedAt: Date.now() - 30 * 60 * 60_000, tell: false, readOnly: false },
      ]);
      const first = await chat.text("did my cinema ticket come through?", "Let me look.");
      const requests = chat.world.model.requests;
      const body = requests.at(-1) ?? {};
      const system = JSON.stringify(body.system ?? "");
      const messages = JSON.stringify(body.messages ?? []);
      assert.match(system, /Their connected mailboxes: rowan@work\.example, rowan\.home@mail\.example/, "the turn is told every connected mailbox, in the cached part");
      assert.match(system, /searches every one of them at once/, "and that one search asks them all");
      assert.ok(!system.includes("hasn't synced"), "a mailbox's state is never in the cached part");
      assert.match(messages, /rowan\.home@mail\.example hasn't synced for hours/, "the one not fine now is named per text");
      assert.ok(first.shown.includes("rowan@work.example"));
    } finally {
      chat.restore();
    }
  },
};

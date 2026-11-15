import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";
import { PLAYBOOK_PATH } from "../../../src/agent/groupPlaybook.js";

export default {
  id: "playbook-after-mail",
  incident: "2026-11-15: a member said \"yes, and every one after\" to having each new referral posted in the chat, and Tex said it couldn't save that as a standing rule, because the turn had read the referral email.",
  cause: "The playbook refused any change on a turn that had read an email, a page or a file, even when a member asked for it (`withPlaybookGate`, removed by the owner).",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      chat.controlPlane.holdRules("ws_replay_team", { etag: "rules-playbook-1", accessVersion: 1, folders: [{ prefix: "tex/groups", visibility: "team" }], notes: [] });
      chat.team.set("tex/groups/forwarded.md", { body: "---\ntrust: untrusted\n---\n\nNew referral: Pat Lee, home visits from Monday\n", etag: "f1" });
      const content = "# Playbook\n\n## Referrals\n\nPost each new referral in the chat when its email lands. RULE-KEPT\n";
      const steps = [
        { toolCalls: [{ name: "read_note", args: { path: "tex/groups/forwarded.md" } }] },
        { toolCalls: [{ name: "write_note", args: { path: PLAYBOOK_PATH, content } }] },
        { text: "Saved. I'll post each new referral here." },
      ];
      const turn = await chat.tag("ada", "Tex yes, and every one after that too", steps);
      const replies = JSON.stringify(turn.requests.at(-1)?.messages ?? []);
      assert.doesNotMatch(replies, /can't change tex\/groups\/playbook\.md/, "a member's ask is not refused after the turn read an email");
      const kept = chat.team.get(PLAYBOOK_PATH)?.body;
      assert.match(typeof kept === "string" ? kept : new TextDecoder().decode(kept ?? new Uint8Array()), /RULE-KEPT/, "the rule is in the playbook");
    } finally {
      chat.restore();
    }
  },
};

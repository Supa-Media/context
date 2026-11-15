import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";
import { PLAYBOOK_PATH, playbookPath, playbookPrompt, readPlaybook } from "../../../src/agent/groupPlaybook.js";

const HOME = "tex/groups/sand-crane-coast";
const notes = (held) => async (name, args) =>
  name === "read_note" && held[args.path] !== undefined ? { content: [{ type: "text", text: `etag: e1\n\n${held[args.path]}` }] } : { isError: true, content: [{ type: "text", text: "not found" }] };

export default {
  id: "playbook-after-mail",
  incident: "2026-11-15: a member said \"yes, and every one after\" to having each new referral posted in the chat, and Tex said it couldn't save that as a standing rule, because the turn had read the referral email. Asked again once that was fixed, Tex said this chat isn't allowed to write there.",
  cause: "The playbook refused any change on a turn that had read an email, a page or a file, even when a member asked for it (`withPlaybookGate`, removed by the owner). Then: the playbook was one note per workspace, tex/groups/playbook.md, and a chat with a home may write only inside its home, so the save was refused every time (moved into the home by the owner).",
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
    // A chat with a home keeps its playbook there, and is told to save it there.
    const group = { home: { folder: HOME, dispatch: notes({ [`${HOME}/playbook.md`]: "## Referrals\nPost each one. HOME-RULE" }) } };
    assert.equal(playbookPath(group), `${HOME}/playbook.md`, "the playbook is the home's own note");
    group.playbook = await readPlaybook(notes({}), group);
    assert.match(group.playbook, /HOME-RULE/, "every turn reads the home's playbook");
    const told = playbookPrompt(group);
    assert.ok(told.includes(`${HOME}/playbook.md (context: "@context-lc")`), "the turn is told to save it in its home");
    assert.ok(!told.includes(PLAYBOOK_PATH), "never told the shared path it can't write");
  },
};

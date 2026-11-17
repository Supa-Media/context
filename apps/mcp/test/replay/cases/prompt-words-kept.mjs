import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { fingerprint } from "../../../src/agent/promptManifest.js";
import { oneToOne } from "../chats.mjs";

export default {
  id: "prompt-words-kept",
  incident: "2026-11-17, a group chat: a check-in was told \"@<sponsor> tagged you.\" every four hours, and Replay showed that module as a size and a fingerprint with no words, so nobody could see the false line until it was rebuilt by hand.",
  cause: "A turn kept each prompt module's id, length and fingerprint only; the words of the modules built from the moment (the time, why it ran, the thread, the workspaces) were never kept.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    await chat.text("what's on Thursday?", "Dinner at 7.");
    const { entries } = await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT);
    const reply = entries.find((entry) => entry.kind === "reply");
    const round = reply.timing.rounds[0].prompt;
    const now = round.modules.find((m) => m.id === "preamble/now");
    assert.ok(now, "the round names the time module");
    const words = round.words?.[now.h];
    assert.equal(typeof words, "string", "and keeps its words beside its fingerprint");
    assert.equal(fingerprint(words), now.h, "the words are the ones that ran");
    const stable = round.modules.find((m) => m.id.startsWith("stable/"));
    assert.equal(round.words[stable.h], undefined, "the stable rules stay the catalogue's");
  },
};

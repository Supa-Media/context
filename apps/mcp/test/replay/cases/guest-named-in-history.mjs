import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { weekStart, weekTurn } from "../../../src/agent/weekHistory.js";
import { guestNameEntry } from "../../../src/agent/groupGuestNames.js";
import { eventEntry } from "../../../src/agent/ledger.js";
import { texLedger } from "../../../src/texStore/ledger.js";
import { durableSql } from "../../texStoreFixture.mjs";

const ZONE = "America/New_York";
const NOW = Date.parse("2026-11-18T19:00:00Z");
const text = (at, n, who, words) =>
  eventEntry({ id: `${at}-${String(n).padStart(6, "0")}`, at, chat: "chat", from: { kind: "person", name: who, who: createHash("sha256").update(who).digest("hex") }, kind: "text", text: words });

export default {
  id: "guest-named-in-history",
  incident: "2026-11-18: in a group chat with two AI guests the chat had kept their names since 11-12, yet Tex said it still slipped on who said what, because senders showed up as guest labels.",
  cause: "The week's history and read_day printed each guest by its bare label (\"@guest-66ef: ...\"); only the chat's people list put the kept name beside it.",
  path: "group history",
  async run() {
    const ledger = texLedger(durableSql());
    await ledger.append("chat", [guestNameEntry("guest-66ef", "Instinct", { by: "about", at: weekStart(NOW, ZONE) - 6 * 86_400_000 })]);
    await ledger.append("chat", [
      text(NOW - 3 * 3600e3, 1, "ada", "instinct can you run a poll?"),
      text(NOW - 3 * 3600e3 + 10_000, 2, "guest-66ef", "not native polls, I can tally reactions."),
    ]);
    const built = await weekTurn({ ledger, chat: "chat", now: NOW, timeZone: ZONE, log: () => {} });
    assert.match(built.history.text, /@guest-66ef \(Instinct\): not native polls/, "the guest's kept name is beside its label on its line");
    assert.match(built.history.text, /@ada: instinct can you run a poll\?/, "an account is its handle");
  },
};

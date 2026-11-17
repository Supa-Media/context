/**
 * THE CHAT BEFORE A BENCH TEXT, AND WHAT A TURN THE WORKER QUEUES ITSELF READS OF IT (`world.mjs` `createWorld`).
 *
 * `earlier` posts a case's earlier lines as the Worker posts them, and keeps an earlier trigger's answer as production
 * keeps that kind (`byCode.mjs` `keepOneToOne`). `chatSide`, `ledgerEntries` and `placeInHome` are what `byCode.mjs`
 * and its tests read of the chat: its group's home, its ledger, a note put in the home.
 */

import { QUIET_MS } from "../src/agent/checkInGather.js";
import { atEarlierTime } from "./clock.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { keepOneToOne } from "./byCode.mjs";
import { clientDispatch, keepEarlierPictures } from "./earlierPictures.mjs";

/**
 * The chat's side of a bench world. `workspaceId` and `mailbox` are read when used (the person's mailbox can open
 * later, when mail first arrives); `mailArrives` puts an email in the person's Gmail.
 */
export function worldChat({ env, token, group, tagger, textedEvent, postEvents, workspaceId, timeZone, mailbox, mailArrives }) {
  return {
    /**
     * A chat before its text, each line posted as the Worker posts it (theirs a text, Tex's its answer to the one before);
     * nothing is answered. A trigger line (`- earlier check-in mail:`, `- earlier routine:`, `- earlier job reports:`)
     * covers no text of theirs, and Tex's texts after it are kept as production keeps that kind (`byCode.mjs`).
     * Before a one-to-one check-in (`checkIn`) the whole chat is dated back past `QUIET_MS`, as production has it: the
     * check-in says "busy" mid-conversation and the control plane asks again once the chat is quiet (`checkin.js`); a
     * group's look has no such wait. Dated now, every Dev check-in row came back "(stayed quiet: busy)". A line with
     * `minutesBefore` is posted that long before the text, the clock set back for it (`clock.mjs` atEarlierTime), as
     * the Worker posted it live then: production's ledger keeps each text's own time.
     */
    async earlier(lines, { checkIn = false } = {}) {
      const quietFor = checkIn && !group ? QUIET_MS + 60_000 : 0;
      const back = (line) => Math.max(quietFor, (line?.minutesBefore ?? 0) * 60_000);
      const at = () => Date.now();
      let last = null;
      let trigger = null;
      let held = [];
      const keepTrigger = async () => {
        if (trigger === null) return;
        await atEarlierTime(back(trigger), keepTriggerThen);
        trigger = null;
        held = [];
      };
      const keepTriggerThen = async () => {
        const turn = textedEvent("", null, at()).turn;
        const texts = held.map((line) => line.text);
        const post = group ? texts : await keepOneToOne({ env, workspaceId: workspaceId(), trigger, texts, at: at(), turn });
        for (const text of post) await postEvents([{ ...textedEvent(text, null, at()), from: { kind: "tex" }, turn, covers: [], delivered: true }]);
      };
      for (const line of lines) {
        if (trigger !== null && line.from === "tex") {
          held.push(line);
          continue;
        }
        await keepTrigger();
        if (line.from === "trigger") {
          // A one-to-one check-in's email is in their Gmail; a group's is in a mailbox shared with the chat, not the tagger's.
          if (line.via === "checkin" && line.mail && !group) await atEarlierTime(back(line), async () => mailArrives(line.mail)); // as it arrived then
          trigger = line;
          last = null;
          continue;
        }
        const sender = line.who && group ? group.people.get(line.who) : tagger; // a group's other member: `- earlier @priya:`
        if (line.who && group && !sender) throw new Error(`@${line.who} is not in the group's workspace (people.md)`);
        await atEarlierTime(back(line), async () => {
          const event = { ...textedEvent(line.text, line.from === "person" ? sender : null, at()), ...(line.pictures?.length ? { kind: "picture", pictures: line.pictures } : {}) };
          if (line.from === "person") last = event;
          const { pictures, ...posted } = line.from === "person" ? event : { ...event, from: { kind: "tex" }, turn: last?.turn ?? event.turn, covers: last ? [last.id] : [], delivered: true };
          await postEvents([posted]); // Tex's answer to a picture kept it, as that turn did (`earlierPictures.mjs`)
          if (line.from === "tex" && last?.pictures) await keepEarlierPictures({ env, token, workspaceId: workspaceId(), group, timeZone, at: last.at, turn: last.turn, names: last.pictures });
        });
      }
      await keepTrigger();
    },

    /** What a turn the Worker queues itself needs to know of this chat (`byCode.mjs`): its group's home and who tags, the zone, the mailbox. */
    chatSide() {
      return { group: group ? { home: group.home } : null, handle: tagger?.handle ?? null, timeZone: timeZone, mailbox: mailbox() };
    },

    /** The chat's ledger as the gateway keeps it (`ledger.js`): every entry, oldest first, for a test to read. */
    async ledgerEntries() {
      const ledger = ledgerFor(env, group ? { chat: group.key } : { person: workspaceId() });
      const read = await ledger.read(group ? group.key : ONE_TO_ONE_CHAT, { before: Number.MAX_SAFE_INTEGER, limit: 5_000, jobs: true });
      return [...(read.entries ?? read)].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    },

    /** A note put into the group chat's home as if it were already there (a chat routine's words), through its home grant. */
    async placeInHome(path, body) {
      if (!group) throw new Error("only a group chat has a home");
      const result = await clientDispatch({ env, token: group.homeToken })("write_note", { path: `${group.home}/${path}`, content: body });
      if (result?.isError) throw new Error(`could not place ${path} in the chat's home: ${(result.content ?? []).map((part) => part.text ?? "").join(" ")}`);
    },
  };
}

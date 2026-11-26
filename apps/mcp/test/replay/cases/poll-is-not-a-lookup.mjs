import assert from "node:assert/strict";
import { askGateNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/askGate.js";

export default {
  id: "poll-is-not-a-lookup",
  incident:
    "2026-11-24, a Lab group chat on main: someone asked Tex to make a poll for which night to do the launch dinner. Tex tapped a reaction, handed the ask to a background job, and no poll was sent.",
  cause:
    "The Before-asking step read the poll's title (\"(poll) Which night…?\") as a question Tex could look up, climbed the ladder, and, still asking, sent the turn to a job.",
  path: "group text on iMessage",
  // The same step's other false send-backs (2026-11-26 audit, all 7 of the week's wrong, each under 27% sure): in a
  // new group someone asked Tex to sum up the action items with nothing said yet; it found only their own ask in the
  // history, named connected apps the group lacked, and climbed at 22% sure. Check-ins had it too, with nobody to ask.
  async run() {
    const asked = [];
    const engine = async (state, questions) => (asked.push({ state, questions }), { kind: { choice: "fact", confidence: 0.2 } });
    const draft = "(poll) Which night for the launch dinner?\n- Thursday\n- Friday\n- Saturday";
    const turn = { env: {}, question: "Tex can you make us a poll for which night to do the launch dinner? Thursday, Friday or Saturday", drafts: { waiting: { draft } } };
    const out = await askGateNode({ askChars: 96, draftChars: draft.length }, { ctx: { turn }, use: {}, engine });
    assert.equal(out.to, "pass", "a poll goes out as the reply");
    assert.equal(asked.length, 0, "with no model reading its title as an ask");
    const beside = await askGateNode({ ask: "make us a poll", draft: `${draft}\n\nWhere should we book?` }, { ctx: { turn: { env: {} } }, use: {}, engine });
    assert.notEqual(beside.to, "pass", "a real question beside the poll is still read");
    assert.equal(asked.length, 1);
    assert.equal(beside.asks, 1, "and only it: the poll's title is not counted");
    await falseSendBacks();
  },
};

async function falseSendBacks() {
    const ask = "Tex, sum up the action items for us";
    const use = {
      rungKnows: async () => ({ found: [`[9:01 PM] @robin: ${ask}   (not answered)`] }),
      rungNotes: async () => ({ found: [] }),
      rungTools: async () => ({ tried: ["knows"], failedApps: [] }),
    };
    const draft = "There's nothing here to sum up yet. Which meeting do you mean?";
    const unsure = async () => ({ kind: { choice: "fact", confidence: 0.22 } });
    const low = await askGateNode({ ask, draft }, { ctx: { turn: { env: {}, group: { mail: [] } } }, use, engine: unsure });
    assert.notEqual(low.to, "back", "an unsure fact goes on as drafted");
    assert.notEqual(low.to, "job");

    const sure = async () => ({ kind: { choice: "fact", confidence: 0.9 } });
    const climbed = await askGateNode({ ask, draft }, { ctx: { turn: { env: {}, group: { mail: [] } } }, use, engine: sure });
    assert.equal(climbed.climbed.knows, 0, "their own ask said back is no find");
    assert.ok(!/history already has/.test(climbed.notice ?? ""), climbed.notice);
    assert.ok(!/connected apps/.test(climbed.notice ?? ""), "a group with no shared mail or calendar is not told to try one");

    const checkin = await askGateNode({ ask: "(check-in)", draft: "Which mail do you mean?" }, { ctx: { turn: { env: {}, finishCheckIn: async () => null } }, use, engine: sure });
    assert.equal(checkin.to, "pass", "a check-in has nobody to ask");
  }

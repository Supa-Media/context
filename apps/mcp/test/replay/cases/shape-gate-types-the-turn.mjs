import assert from "node:assert/strict";
import { doItChecks } from "../../../src/agent/doItChecks.js";
import { HOLD_AT, ONE_LINE_NOTICE, ORDER_NOTICE, TAPBACK_NOTICE, readShape, shapeNote, shapeRequest } from "../../../src/agent/shapeGate.js";

/** Clef's answers for one invented text, as the gate reads them. */
const read = (ending, confidence, order = 0, records = 0) => readShape({ ending: { choice: ending, confidence }, order: { noul: order }, records: { noul: records } });
const wrote = [{ role: "user", text: "put milk on the list" }, { role: "tool", name: "write_note", text: "saved" }];
const LONG = Array.from({ length: 12 }, (_, n) => `Sentence ${n + 1} says a little more about the bakery's hours than anyone asked for.`).join(" ");

export default {
  id: "shape-gate-types-the-turn",
  incident: "2026-11-17: on the Dev set a finished simple act got a sentence where a friend would react, a one-line ask got a paragraph, and an order to act got an offer. Each is a stable miss, and every notice and prompt change tried for them stayed inside the run-to-run noise.",
  cause: "Length, what leads and how a turn ends were left to one model reading the whole setup: nothing in the graph knew what kind of answer the turn was. The Shape gate types the text beside the Door, the Front door is told the read, and the code checks hold it where Clef was sure, each contract once, never on a text that tagged Tex.",
  path: "1:1 text",
  async run() {
    // The gate asks three typed questions about the text alone.
    const asked = shapeRequest("put milk on the list", { group: false });
    assert.deepEqual(Object.keys(asked.questions), ["ending", "order", "records"]);
    assert.match(asked.state, /put milk on the list/);

    // A done simple act with a sentence drafted goes back once, toward the tapback; the second draft goes.
    const simple = doItChecks({ question: "put milk on the list", shape: read("tapback", 0.95, 0.9) });
    assert.equal(await simple.check("Added milk to your list.", { messages: wrote }), TAPBACK_NOTICE);
    assert.equal(await simple.check("Added milk to your list.", { messages: wrote }), null, "once a turn: it never holds an answer twice");

    // One line read, a draft several times that: back once.
    const line = doItChecks({ question: "is the bakery open sunday", shape: read("one_line", 0.9) });
    assert.equal(await line.check(LONG, { messages: [] }), ONE_LINE_NOTICE);
    assert.equal(await line.check("Yes, 8 to 2.", { messages: [] }), null);

    // An order with no call behind the draft: back once.
    const order = doItChecks({ question: "book the 6pm table", shape: read("answer", 0.7, 0.92) });
    assert.equal(await order.check("I can book that for you if you'd like.", { messages: [] }), ORDER_NOTICE);

    // Never on a text that tagged Tex, never below the confidence it holds at, never after a failed call, and never without a gate.
    const tagged = doItChecks({ question: "@Tex put milk on the list", shape: read("tapback", 0.99, 0.99), tagged: true });
    assert.equal(await tagged.check("Added milk to your list.", { messages: wrote }), null);
    const unsure = doItChecks({ question: "put milk on the list", shape: read("tapback", HOLD_AT - 0.01, HOLD_AT - 0.01) });
    assert.equal(await unsure.check("Added milk to your list.", { messages: wrote }), null);
    const failed = doItChecks({ question: "put milk on the list", shape: read("tapback", 0.95) });
    assert.equal(await failed.check("That didn't save, the list is locked.", { messages: [...wrote, { role: "tool", name: "write_note", text: "refused", isError: true }] }), null, "a failure is told in words");
    const none = doItChecks({ question: "put milk on the list" });
    assert.equal(await none.check(LONG, { messages: [] }), null, "with the gate off the checks are what they were");

    // What the Front door is told is a read, in words, and nothing when Clef was not sure.
    assert.match(shapeNote(read("one_line", 0.8, 0.1, 0.7)), /one short line, the answer first[\s\S]*stored: read it before you answer/);
    assert.equal(shapeNote(read("answer", 0.3, 0.2, 0.2)), "");
    assert.equal(shapeNote(null), "");
  },
};

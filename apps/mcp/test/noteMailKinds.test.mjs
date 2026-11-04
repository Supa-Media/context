/**
 * Note mail kinds (`packages/shared/src/mail.cjs`): the optional `[ask]` and
 * `[interrupt]` tags, the pair count, and the ask depth. The format is checked
 * here against the module itself; the tools that call it are covered by
 * `noteMail.test.mjs`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import mail from "../../../packages/shared/src/mail.cjs";
import comments from "../../../packages/shared/src/comments.cjs";

const NOW = Date.parse("2026-11-04T06:00:00.000Z");

function send(text, entry) {
  const outcome = mail.appendMail(text, entry);
  assert.ok(!outcome.error, outcome.error);
  return comments.applyChanges(text, outcome.changes);
}

/** Build a note with the given mail entries, appended in order. */
function note(...entries) {
  let text = "# Plan\n";
  for (const entry of entries) text = send(text, entry);
  return text;
}

const mailAt = (at, from, to, mailKind, text = "x") => ({ at, from, app: null, kind: "mail", to, mailKind, text });

/* -------------------------------------------------------------------------- */
/* Format                                                                     */
/* -------------------------------------------------------------------------- */

test("lines written before kinds existed parse unchanged, as notes", () => {
  const text = [
    "# Plan",
    "",
    "```mail",
    "- 2026-10-15T18:20:00.000Z lead (Claude) joined",
    "- 2026-10-15T18:21:04.512Z lead (Claude) to everyone: Plan is above. We check mail every 10 minutes.",
    "- 2026-10-15T18:25:40.001Z builder (Codex) to lead: Pricing page done.",
    "    A second line is indented four spaces.",
    "- 2026-10-15T18:26:00.000Z @seyi to everyone: Keep the launch on Tuesday.",
    "```",
    "",
  ].join("\n");
  const { events } = mail.parseMail(text);
  assert.deepEqual(events, [
    {
      at: "2026-10-15T18:20:00.000Z",
      from: "lead",
      app: "Claude",
      kind: "joined",
      to: null,
      mailKind: null,
      text: "",
      start: events[0].start,
      end: events[0].end,
    },
    {
      at: "2026-10-15T18:21:04.512Z",
      from: "lead",
      app: "Claude",
      kind: "mail",
      to: "everyone",
      mailKind: "note",
      text: "Plan is above. We check mail every 10 minutes.",
      start: events[1].start,
      end: events[1].end,
    },
    {
      at: "2026-10-15T18:25:40.001Z",
      from: "builder",
      app: "Codex",
      kind: "mail",
      to: "lead",
      mailKind: "note",
      text: "Pricing page done.\nA second line is indented four spaces.",
      start: events[2].start,
      end: events[2].end,
    },
    {
      at: "2026-10-15T18:26:00.000Z",
      from: "@seyi",
      app: null,
      kind: "mail",
      to: "everyone",
      mailKind: "note",
      text: "Keep the launch on Tuesday.",
      start: events[3].start,
      end: events[3].end,
    },
  ]);
});

test("ask and interrupt round-trip through appendMail and parseMail", () => {
  const text = note(
    { at: "2026-11-04T05:00:00.000Z", from: "builder", app: "Claude", kind: "mail", to: "lead", mailKind: "ask", text: "Which file?" },
    { at: "2026-11-04T05:01:00.000Z", from: "tex", app: "Context texts", kind: "mail", to: "builder", mailKind: "interrupt", text: "Stop and do X." },
    { at: "2026-11-04T05:02:00.000Z", from: "lead", app: "Claude", kind: "mail", to: "everyone", text: "Plain note." },
    { at: "2026-11-04T05:03:00.000Z", from: "lead", app: "Claude", kind: "mail", to: "builder", mailKind: "note", text: "Explicit note." }
  );
  assert.ok(text.includes("- 2026-11-04T05:00:00.000Z builder (Claude) to lead [ask]: Which file?\n"), text);
  assert.ok(text.includes("- 2026-11-04T05:01:00.000Z tex (Context texts) to builder [interrupt]: Stop and do X.\n"), text);
  assert.ok(text.includes("- 2026-11-04T05:02:00.000Z lead (Claude) to everyone: Plain note.\n"), text);
  assert.ok(!text.includes("[note]"), "a note is never written with a tag");
  const { events } = mail.parseMail(text);
  assert.deepEqual(
    events.map((event) => [event.from, event.to, event.mailKind, event.text]),
    [
      ["builder", "lead", "ask", "Which file?"],
      ["tex", "builder", "interrupt", "Stop and do X."],
      ["lead", "everyone", "note", "Plain note."],
      ["lead", "builder", "note", "Explicit note."],
    ]
  );
});

test("a tagged message with a second line keeps the whole message", () => {
  const text = [
    "```mail",
    "- 2026-11-04T05:00:00.000Z builder (Claude) to lead [ask]: Which file?",
    "    The one under apps/mcp.",
    "    Or the one under packages.",
    "- 2026-11-04T05:01:00.000Z lead (Claude) to builder: Thanks.",
    "```",
  ].join("\n");
  const { events } = mail.parseMail(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].mailKind, "ask");
  assert.equal(events[0].text, "Which file?\nThe one under apps/mcp.\nOr the one under packages.");
  assert.equal(events[1].mailKind, "note");
  assert.equal(mail.describeEntry(events[0]), "- 2026-11-04T05:00:00.000Z builder (Claude) to lead [ask]: Which file?\n    The one under apps/mcp.\n    Or the one under packages.");
});

test("an unknown tag is not a tag, and the line is skipped as it was before", () => {
  const text = [
    "```mail",
    "- 2026-11-04T05:00:00.000Z builder (Claude) to lead [foo]: Not a tag.",
    "    An indented line after a skipped line is not a continuation of anything.",
    "- 2026-11-04T05:01:00.000Z builder (Claude) to lead [note]: Never written, so not read either.",
    "- 2026-11-04T05:02:00.000Z lead (Claude) to builder: Kept.",
    "```",
  ].join("\n");
  const { events } = mail.parseMail(text);
  assert.deepEqual(
    events.map((event) => [event.at, event.text, event.mailKind]),
    [["2026-11-04T05:02:00.000Z", "Kept.", "note"]]
  );
});

test("appendMail refuses a kind it does not know, and writes nothing", () => {
  const outcome = mail.appendMail("", { at: "2026-11-04T05:00:00.000Z", from: "lead", kind: "mail", to: "everyone", text: "hi", mailKind: "shout" });
  assert.equal(outcome.error, 'mail.kind must be "note", "ask" or "interrupt"');
  assert.equal(outcome.changes, undefined);
  const withNull = mail.appendMail("", { at: "2026-11-04T05:00:00.000Z", from: "lead", kind: "mail", to: "everyone", text: "hi", mailKind: null });
  assert.equal(withNull.error, 'mail.kind must be "note", "ask" or "interrupt"');
});

test("the kinds, the depth cap and the pair limit are exported", () => {
  assert.deepEqual([...mail.MAIL_KINDS], ["note", "ask", "interrupt"]);
  assert.equal(mail.MAX_ASK_DEPTH, 3);
  assert.equal(mail.MAX_PER_PAIR_PER_HOUR, 20);
});

/* -------------------------------------------------------------------------- */
/* Pair count                                                                 */
/* -------------------------------------------------------------------------- */

test("pairCount counts mail one way between two names in the hour before now", () => {
  const text = note(
    mailAt("2026-11-04T05:30:00.000Z", "builder", "lead", "note"), // 30 min ago: counts
    mailAt("2026-11-04T05:10:00.000Z", "builder", "lead", "ask"), // 50 min ago: counts
    mailAt("2026-11-04T04:59:00.000Z", "builder", "lead", "note"), // 61 min ago: outside the window
    mailAt("2026-11-04T05:20:00.000Z", "lead", "builder", "note"), // the other way: not this pair
    mailAt("2026-11-04T05:20:00.000Z", "builder", "everyone", "note"), // to everyone: not this pair
    mailAt("2026-11-04T05:20:00.000Z", "builder", "tex", "interrupt") // another recipient
  );
  const { events } = mail.parseMail(text);
  assert.equal(mail.pairCount(events, "builder", "lead", NOW), 2);
  assert.equal(mail.pairCount(events, "lead", "builder", NOW), 1);
  assert.equal(mail.pairCount(events, "builder", "everyone", NOW), 1);
  assert.equal(mail.pairCount(events, "builder", "lead", NOW, 2 * 3600000), 3);
  assert.equal(mail.pairCount(events, "builder", "lead", NOW, 60 * 1000), 0);
});

test("pairCount does not count joins", () => {
  const text = note({ at: "2026-11-04T05:30:00.000Z", from: "builder", app: "Claude", kind: "joined" });
  assert.equal(mail.pairCount(mail.parseMail(text).events, "builder", "lead", NOW), 0);
});

/* -------------------------------------------------------------------------- */
/* Ask depth                                                                  */
/* -------------------------------------------------------------------------- */

test("askDepth: no asks means the first ask is depth 1", () => {
  assert.equal(mail.askDepth([], "ann"), 1);
  const text = note(mailAt("2026-11-04T05:00:00.000Z", "ann", "ben", "note"));
  assert.equal(mail.askDepth(mail.parseMail(text).events, "ann"), 1);
});

test("askDepth: a chain A asks B, B asks C, C answers B, then B is back to 2", () => {
  let text = note(mailAt("2026-11-04T05:00:00.000Z", "ann", "ben", "ask", "Which file?"));
  let events = mail.parseMail(text).events;
  assert.equal(mail.askDepth(events, "ben"), 2, "B's new ask follows A's ask to B");

  text = send(text, { at: "2026-11-04T05:01:00.000Z", from: "ben", kind: "mail", to: "cy", mailKind: "ask", text: "Can you check?" });
  events = mail.parseMail(text).events;
  assert.equal(mail.askDepth(events, "cy"), 3, "C's new ask follows B's ask, which is itself depth 2");
  assert.equal(mail.askDepth(events, "ben"), 2, "B's chain is still open to A, and C is not in it");

  text = send(text, { at: "2026-11-04T05:02:00.000Z", from: "cy", kind: "mail", to: "ben", text: "Checked." });
  events = mail.parseMail(text).events;
  assert.equal(mail.askDepth(events, "ben"), 2, "C's answer closes B -> C, and A -> B is still open for B");
  assert.equal(mail.askDepth(events, "cy"), 1, "nothing is open for C now");
});

test("askDepth: an answer of any kind closes an ask, and an interrupt counts", () => {
  const text = note(
    mailAt("2026-11-04T05:00:00.000Z", "ann", "ben", "ask"),
    mailAt("2026-11-04T05:01:00.000Z", "ben", "ann", "interrupt", "Stop."),
  );
  assert.equal(mail.askDepth(mail.parseMail(text).events, "ben"), 1);
});

test("askDepth: an ask to everyone is open for everyone but its sender, until each answers", () => {
  let text = note(mailAt("2026-11-04T05:00:00.000Z", "ann", "everyone", "ask", "Anyone free?"));
  let events = mail.parseMail(text).events;
  assert.equal(mail.askDepth(events, "ben"), 2);
  assert.equal(mail.askDepth(events, "cy"), 2);
  assert.equal(mail.askDepth(events, "ann"), 1, "the sender is not asked");

  text = send(text, { at: "2026-11-04T05:01:00.000Z", from: "ben", kind: "mail", to: "ann", text: "Me." });
  events = mail.parseMail(text).events;
  assert.equal(mail.askDepth(events, "ben"), 1, "B answered A, so B is clear");
  assert.equal(mail.askDepth(events, "cy"), 2, "C has not answered yet");

  text = send(text, { at: "2026-11-04T05:02:00.000Z", from: "cy", kind: "mail", to: "everyone", text: "Also me." });
  events = mail.parseMail(text).events;
  assert.equal(mail.askDepth(events, "cy"), 1, "a message to everyone answers for C too");
});

test("askDepth: an ask to everyone from B is open for A and C, and depths stack", () => {
  const text = note(
    mailAt("2026-11-04T05:00:00.000Z", "ann", "ben", "ask"),
    mailAt("2026-11-04T05:01:00.000Z", "ben", "everyone", "ask"),
  );
  const events = mail.parseMail(text).events;
  assert.equal(mail.askDepth(events, "ann"), 3, "A is asked by B's ask, which followed A's ask to B");
  assert.equal(mail.askDepth(events, "cy"), 3);
});

test("a plain note is not an ask, and it counts towards the pair", () => {
  const text = note(mailAt("2026-11-04T05:30:00.000Z", "ann", "ben", "note"));
  const { events } = mail.parseMail(text);
  assert.equal(mail.askDepth(events, "ben"), 1, "a note is not an ask");
  assert.equal(mail.pairCount(events, "ann", "ben", NOW), 1);
});

test("describeEntry writes the tag for ask and interrupt, and not for a note", () => {
  const events = mail.parseMail(
    note(
      mailAt("2026-11-04T05:00:00.000Z", "builder", "lead", "ask", "Which file?"),
      mailAt("2026-11-04T05:01:00.000Z", "tex", "builder", "interrupt", "Stop."),
      mailAt("2026-11-04T05:02:00.000Z", "lead", "builder", "note", "Ok.")
    )
  ).events;
  assert.equal(mail.describeEntry(events[0]), "- 2026-11-04T05:00:00.000Z builder to lead [ask]: Which file?");
  assert.equal(mail.describeEntry(events[1]), "- 2026-11-04T05:01:00.000Z tex to builder [interrupt]: Stop.");
  assert.equal(mail.describeEntry(events[2]), "- 2026-11-04T05:02:00.000Z lead to builder: Ok.");
});

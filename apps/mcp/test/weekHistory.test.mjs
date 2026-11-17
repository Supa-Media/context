/**
 * THE SAME HISTORY MODULE FOR EVERY CHAT (`src/agent/weekHistory.js`; Dev2, 2026-11-16: the last 7 days word for word,
 * each earlier day as its summary ending with the exact `read_day` call, day summaries for every chat, groups
 * included, and pictures kept by id and shown inline within the 7 days).
 *
 * Sabotage record (2026-11-17), each applied, this file run, named test failing, reverted:
 *  1. `weekStart` going back 7 days instead of 6 → "the window starts at midnight six days back…" fails.
 *  2. `summaryPart` dropping `dayLine` → "each earlier day is its summary, ending with the exact read_day call…" fails.
 *  3. `weekView` reading with `fade: true` → "the seven days are word for word…" fails (a long answer cut).
 *  4. `inlinePictureBlocks` putting the picture before its marker → "a picture's block comes right after the line…" fails.
 *  5. `writeChatDaySummaries` writing to `texts` instead of `chat` → "a group's finished days are summed up…" fails.
 *  6. `readsWeek` true for `hist` → "main's front door reads `week`…" fails (the draft putting `hist` back).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dayLine, dayBefore, midnightOf, picturesOf, readDayTool, readsWeek, summaryPart, weekOn, weekStart, weekTurn, weekView, WEEK_MODULE,
} from "../src/agent/weekHistory.js";
import { anthropicMessages, inlinePictureBlocks } from "../src/agent/providers.js";
import { writeChatDaySummaries } from "../src/agent/daySummaries.js";
import chatDays from "../src/agent/graph/nodes/chatDays.js";
import { keepTextedPictures, picturesPath } from "../src/agent/textedPictures.js";
import { eventEntry } from "../src/agent/ledger.js";
import { texLedger } from "../src/texStore/ledger.js";
import { TEX_CONFIG, texStep, withDraft } from "../src/agent/texConfig.js";
import { durableSql } from "./texStoreFixture.mjs";
import { threadedTurn } from "../src/agent/threadedTurn.js";
import { fakeModel } from "./agentEgressFixtures.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN } from "./agentModelFixture.mjs";

const DAY = 86_400_000;
const ZONE = "America/New_York";
// Tuesday, Nov 17 2026, 3 pm in New York.
const NOW = Date.parse("2026-11-17T20:00:00Z");
let n = 0;
const said = (chat, at, who, text, extra = {}) => {
  n += 1;
  const from = who === "tex" ? { kind: "tex" } : { kind: "person", name: who, who: `h-${who}` };
  return eventEntry({ id: `${at}-${String(n).padStart(6, "0")}`, at, chat, from, kind: "text", text, ...(who === "tex" ? { delivered: true } : {}), ...extra });
};
const summary = (day, at, text) => ({ v: 1, id: `day-${day}`, at, kind: "day", day, text });

test("main's front door reads `week` (promoted 2026-11-17), and a draft that puts `hist` back turns it off", () => {
  assert.equal(readsWeek(texStep("fd")), true);
  assert.equal(weekOn({}), true);
  const fd = texStep("fd");
  const drafted = withDraft(TEX_CONFIG, { nodes: [{ id: "fd", ctx: fd.ctx.map((key) => (key === WEEK_MODULE ? "hist" : key)) }] });
  assert.equal(readsWeek(texStep("fd", drafted)), false);
});

test("the window starts at midnight six days back in the chat's zone, so it moves once a day", () => {
  assert.equal(midnightOf("2026-11-17", ZONE), Date.parse("2026-11-17T05:00:00Z"));
  assert.equal(midnightOf("2026-11-01", ZONE), Date.parse("2026-11-01T04:00:00Z"), "the day the clocks change");
  assert.equal(dayBefore("2026-11-17", 6), "2026-11-11");
  assert.equal(weekStart(NOW, ZONE), Date.parse("2026-11-11T05:00:00Z"));
  assert.equal(weekStart(NOW + 3 * 3600e3, ZONE), weekStart(NOW, ZONE), "the same all day");
  assert.equal(weekStart(Date.parse("2026-11-18T05:30:00Z"), ZONE), Date.parse("2026-11-12T05:00:00Z"), "a day later after midnight");
});

test("each earlier day is its summary, ending with the exact read_day call for that day", () => {
  const part = summaryPart([{ day: "2026-11-08", text: "They planned the picnic." }, { day: "2026-11-09", text: "You booked the van." }]);
  assert.match(part, /- Sun, Nov 8 \(2026-11-08\): They planned the picnic\. To read that day's whole transcript, call read_day with \{"day": "2026-11-08"\}\./);
  assert.match(part, /\(2026-11-09\): You booked the van\. To read that day's whole transcript, call read_day with \{"day": "2026-11-09"\}\./);
  assert.equal(dayLine("2026-11-09"), 'To read that day\'s whole transcript, call read_day with {"day": "2026-11-09"}.');
  assert.equal(summaryPart([]), "");
});

test("the seven days are word for word, older texts are only their summaries, and the texts it answers are left out", () => {
  const start = weekStart(NOW, ZONE);
  const long = `${"a very long answer ".repeat(80)}END-OF-ANSWER`;
  const entries = [
    said("texts", start - 2 * DAY, "maya", "OLD-TEXT from two weeks back"),
    said("texts", start + 3600e3, "maya", "first text of the week"),
    said("texts", start + 3600e3 + 5000, "tex", long, { turn: "t1", covers: [] }),
    said("texts", NOW - 60_000, "maya", "THE-NEW-TEXT"),
  ].reverse();
  const asking = entries[0].eid;
  const view = weekView({ entries, chat: "texts", start, summaries: [{ day: "2026-11-09", text: "OLD-DAY summary." }], skip: (event) => event.id === asking, timeZone: ZONE });
  assert.match(view.text, /OLD-DAY summary\. To read that day's whole transcript/);
  assert.match(view.text, /first text of the week/);
  assert.match(view.text, /END-OF-ANSWER/, "Tex's long answer five days ago is whole");
  assert.doesNotMatch(view.text, /OLD-TEXT/, "a text before the seven days is not shown word for word");
  assert.doesNotMatch(view.text, /THE-NEW-TEXT/, "the text being answered comes as the question");
  assert.ok(view.text.indexOf("OLD-DAY") < view.text.indexOf("first text of the week"), "the summaries come first");
});

test("a picture kept on a turn is shown by its id under the text that sent it, and its block comes right after that line", () => {
  const start = weekStart(NOW, ZONE);
  const photo = said("chat", start + DAY, "ada", "￼", { kind: "file" });
  photo.event = "file";
  const answer = said("chat", start + DAY + 5000, "tex", "Nice shot of the venue.", { turn: "turn-1", covers: [photo.eid] });
  const reply = { v: 1, id: "r1", at: start + DAY + 5001, kind: "reply", turn: "turn-1", attached: "[Sent with this text: IMG_1.jpg (image upload-abc123.jpg in tex/groups/band/pictures/2026-11.md). read_image with that note…]" };
  const entries = [photo, answer, reply].reverse();
  assert.deepEqual(picturesOf(entries).get(photo.eid), [{ id: "upload-abc123.jpg", note: "tex/groups/band/pictures/2026-11.md" }]);
  const view = weekView({ entries, chat: "chat", start, timeZone: ZONE });
  assert.match(view.text, /@ada: \(a file\)[^\n]*\n\s+\[picture upload-abc123\.jpg\]/);
  assert.deepEqual(view.pictures, [{ marker: "[picture upload-abc123.jpg]", id: "upload-abc123.jpg", note: "tex/groups/band/pictures/2026-11.md" }]);

  const blocks = inlinePictureBlocks("before\n[picture upload-abc123.jpg]\nafter", [{ marker: "[picture upload-abc123.jpg]", mediaType: "image/jpeg", data: "QUJD" }]);
  assert.deepEqual(blocks.map((block) => block.type), ["text", "image", "text"]);
  assert.match(blocks[0].text, /\[picture upload-abc123\.jpg\]$/);
  assert.equal(blocks[2].text, "\nafter");
  const wire = anthropicMessages([{ role: "user", text: "before\n[picture upload-abc123.jpg]\nafter", pictures: [{ marker: "[picture upload-abc123.jpg]", mediaType: "image/jpeg", data: "QUJD" }] }]);
  assert.equal(wire[0].content[1].type, "image");
  assert.equal(wire[0].content[1].source.data, "QUJD");
});

test("a one-to-one chat and a group get the same history from the same entries, with its pictures and read_day", async () => {
  const build = async (chat) => {
    const ledger = texLedger(durableSql());
    const start = weekStart(NOW, ZONE);
    const photo = { ...said(chat, start + DAY, "ada", "￼"), event: "file" };
    ledger.append(chat, [
      said(chat, start - 3 * DAY, "ada", "OLD-TEXT"),
      summary("2026-11-08", start - 3 * DAY, "The van was booked."),
      photo,
      said(chat, start + DAY + 5000, "tex", "That's the venue.", { turn: "turn-1", covers: [photo.eid] }),
      { v: 1, id: "r1", at: start + DAY + 5001, kind: "reply", turn: "turn-1", attached: "[Sent with this text: a.jpg (image upload-p1.jpg in tex/pictures/2026-11.md).]" },
      said(chat, NOW - 10 * 60_000, "ada", "what did we decide?"),
    ]);
    const lines = [];
    const built = await weekTurn({ ledger, chat, now: NOW, timeZone: ZONE, readPicture: async (note, id) => ({ mediaType: "image/jpeg", data: `${id}@${note}` }), log: (line) => lines.push(JSON.parse(line)) });
    return { built, lines };
  };
  const one = await build("texts");
  const group = await build("chat");
  assert.equal(one.built.history.text, group.built.history.text, "the same module, word for word");
  assert.match(one.built.history.text, /The van was booked\. To read that day's whole transcript, call read_day with \{"day": "2026-11-08"\}/);
  assert.match(one.built.history.text, /what did we decide\?/);
  assert.doesNotMatch(one.built.history.text, /OLD-TEXT/);
  assert.deepEqual(one.built.history.pictures, [{ marker: "[picture upload-p1.jpg]", mediaType: "image/jpeg", data: "upload-p1.jpg@tex/pictures/2026-11.md" }]);
  assert.equal(one.built.read_day.tool.name, "read_day");
  assert.equal(one.lines[0].event, "tex_week_history");
  assert.equal(one.lines[0].pictures, 1);
  assert.equal(one.lines[0].summaries, 1);
});

test("read_day opens one earlier day word for word, in parts when it is long", async () => {
  const ledger = texLedger(durableSql());
  const day = "2026-11-05";
  const at = midnightOf(day, ZONE);
  ledger.append("chat", [
    said("chat", at - 60_000, "ada", "THE-DAY-BEFORE"),
    said("chat", at + 3600e3, "ada", "MORNING-TEXT"),
    said("chat", at + 3600e3 + 2000, "tex", "MORNING-ANSWER", { turn: "t", covers: [] }),
    said("chat", at + DAY + 60_000, "ada", "THE-DAY-AFTER"),
  ]);
  const tool = readDayTool({ ledger, chat: "chat", timeZone: ZONE, log: () => {} });
  const read = await tool.call({ day });
  const text = read.content[0].text;
  assert.match(text, /MORNING-TEXT/);
  assert.match(text, /You: MORNING-ANSWER/);
  assert.doesNotMatch(text, /THE-DAY-BEFORE|THE-DAY-AFTER/);
  assert.equal((await tool.call({ day: "Nov 5" })).isError, true);
  assert.match((await tool.call({ day: "2026-10-01" })).content[0].text, /Nothing was texted/);

  const busy = texLedger(durableSql());
  const many = Array.from({ length: 300 }, (_, i) => said("chat", at + i * 60_000, "ada", `${"word ".repeat(80)}#${i}`));
  for (let i = 0; i < many.length; i += 100) busy.append("chat", many.slice(i, i + 100));
  const long = readDayTool({ ledger: busy, chat: "chat", timeZone: ZONE, log: () => {} });
  const first = (await long.call({ day })).content[0].text;
  assert.match(first, /Part 1 of 3\. The rest: call read_day with \{"day": "2026-11-05", "part": 2\}/);
  assert.match((await long.call({ day, part: 3 })).content[0].text, /#299/);
});

test("a group's finished days are summed up into its own ledger after a reply, naming who said what, a few at a time", async () => {
  const ledger = texLedger(durableSql());
  ledger.append("chat", [
    said("chat", NOW - 40 * DAY, "ada", "TOO-OLD"),
    ...[5, 4, 3, 2, 1].map((back) => said("chat", NOW - back * DAY, "ada", `DAY-${back} plans`)),
    said("chat", NOW - 1000, "bo", "today"),
  ]);
  const asked = [];
  const request = async (call) => {
    asked.push(call);
    return { text: `Summary of ${call.messages[0].text.match(/DAY-\d+/)[0]}.` };
  };
  const done = await writeChatDaySummaries({ ledger, chat: "chat", group: true, now: NOW, timeZone: ZONE, config: {}, request, max: 3, lookbackDays: 21, log: () => {} });
  assert.deepEqual(done, { written: 3, missing: 3 });
  assert.match(asked[0].system, /group text chat/);
  assert.match(asked[0].messages[0].text, /\*\*@ada \(/, "each text under its sender's name");
  const kept = () => ledger.read("chat", { kinds: ["day"] }).entries.map((entry) => entry.text).sort();
  assert.deepEqual(kept(), ["Summary of DAY-1.", "Summary of DAY-2.", "Summary of DAY-3."], "newest first");
  await writeChatDaySummaries({ ledger, chat: "chat", group: true, now: NOW, timeZone: ZONE, config: {}, request, max: 3, lookbackDays: 21, log: () => {} });
  assert.equal(kept().length, 5, "the next run catches up the rest");
  assert.ok(asked.every((call) => !/TOO-OLD|today/.test(call.messages[0].text)), "never today, never past the lookback");
});

test("the Chat day summaries node sums up the turn's own chat, and stays off when day summaries are off", async () => {
  const ledger = texLedger(durableSql());
  ledger.append("texts", [said("texts", NOW - 2 * DAY, "maya", "DAY-2 ask")]);
  const model = fakeModel();
  model.install([{ text: "They asked about DAY-2." }]);
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) return model.handle(url, init);
    return inner(input, init);
  };
  try {
    const owners = [];
    const store = { texLedger: (owner) => (owners.push(owner), ledger) };
    const turn = { env: { ...AI_GATEWAY_ENV }, store, session: { workspaceKind: "personal", workspaceId: "ws_maya" }, group: null, timeZone: "UTC" };
    assert.deepEqual(await chatDays({}, { ctx: { turn } }), { outcome: "done", written: 1, missing: 1 });
    assert.deepEqual(owners, [null], "the person's own chat");
    assert.equal(ledger.read("texts", { kinds: ["day"] }).entries[0].text, "They asked about DAY-2.");
    assert.deepEqual(await chatDays({}, { ctx: { turn: { ...turn, env: { DAY_SUMMARIES: "off" } } } }), { outcome: "off" });
    assert.deepEqual(await chatDays({}, { ctx: { turn: { ...turn, session: null } } }), { outcome: "none" });
  } finally {
    globalThis.fetch = inner;
  }
});

test("a group's pictures are kept in its home's own pictures folder", async () => {
  const writes = [];
  const dispatch = async (name, args) => {
    writes.push({ name, args });
    if (name === "read_note") return { content: [{ type: "text", text: "not found" }], isError: true };
    return { content: [{ type: "text", text: "applied" }] };
  };
  assert.equal(picturesPath(NOW, "UTC", "tex/groups/band/pictures"), "tex/groups/band/pictures/2026-11.md");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const kept = await keepTextedPictures(dispatch, { now: NOW, timeZone: "UTC", attachments: [{ name: "a.png", mediaType: "image/png", data: png }], folder: "tex/groups/band/pictures", group: true });
  const write = writes.find((call) => call.name !== "read_note");
  assert.ok(write, "a write was made");
  assert.equal(JSON.stringify(write.args).includes("tex/groups/band/pictures/2026-11.md"), true);
  assert.match(JSON.stringify(write.args), /Pictures sent in this chat/);
  assert.deepEqual(kept.map((picture) => picture.note), ["tex/groups/band/pictures/2026-11.md"]);
});

test("a threaded turn on the week shows the 7 days, lists its threads over them, and offers read_day beside read_thread", async () => {
  const ledger = texLedger(durableSql());
  const start = weekStart(NOW, ZONE);
  const asked = said("texts", NOW - 60_000, "maya", "and the hotel?");
  ledger.append("texts", [said("texts", start + DAY, "maya", "WEEK-TEXT about the trip"), summary("2026-11-08", start - 2 * DAY, "OLD-DAY summary."), asked]);
  ledger.append("texts.threads", [{ v: 1, id: "th1", kind: "thread", thread: "t1", at: start + DAY, title: "Trip", description: "planning", status: "open", texts: [] }]);
  const event = (entry) => ({ id: entry.eid, at: entry.at, from: entry.from, kind: "text", text: entry.text });
  const logged = { question: "and the hotel?", replying: [], covered: [event(asked)], parts: { shown: [], answeredBy: [], tools: new Map(), summaries: [], answering: asked.at, timeZone: ZONE, byId: new Map() } };
  const turn = await threadedTurn({ logged, ledger, chat: "texts", week: { grant: null, readPicture: null }, log: () => {} });
  assert.match(turn.history[0].text, /^\(The chat's last 7 days of texts/);
  assert.match(turn.history[0].text, /WEEK-TEXT about the trip/);
  assert.match(turn.history[0].text, /OLD-DAY summary\. To read that day's whole transcript, call read_day with \{"day": "2026-11-08"\}/);
  assert.doesNotMatch(turn.history[0].text, /and the hotel\?/);
  assert.match(turn.note, /the texts below are the last 7 days/);
  assert.equal(turn.read_day.tool.name, "read_day");
  assert.equal(turn.read_thread.tool.name, "read_thread");
});

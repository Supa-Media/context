import assert from "node:assert/strict";
import test from "node:test";
import { saysNotThere, searchedLineOf, withSearchedLine, withSearchRecord } from "../../../packages/tex/gateway/agent/searchClaims.js";

/** A tool result shaped as the gateway returns it: its text in one text part. */
const resultOf = (text, extra = {}) => ({ content: [{ type: "text", text }], ...extra });

const TWO = "Nothing on the public worship reading list.\n\nSearched: @seyi, @supa, @public-worship, @context-lc, @crystal-care.";
const WITH_BROKEN = "Two hits.\n\nSearched: @maya-home, @kiln-guild. Not reachable just now, so not searched: @broken.";
const ONE = "One hit.\n\nSearched: @maya-home.";

test("searchedLineOf keeps the line of a search that covered two or more workspaces", () => {
  assert.equal(searchedLineOf(TWO), "Searched: @seyi, @supa, @public-worship, @context-lc, @crystal-care.");
});

test("searchedLineOf keeps the Not reachable clause on the same line", () => {
  assert.equal(
    searchedLineOf(WITH_BROKEN),
    "Searched: @maya-home, @kiln-guild. Not reachable just now, so not searched: @broken.",
  );
});

test("searchedLineOf is null for a one-workspace search", () => {
  assert.equal(searchedLineOf(ONE), null);
});

test("searchedLineOf is null for text with no Searched line", () => {
  assert.equal(searchedLineOf("- a hit\n\nNothing else here."), null);
  assert.equal(searchedLineOf(""), null);
  assert.equal(searchedLineOf(undefined), null);
});

test("searchedLineOf reads only the last paragraph", () => {
  assert.equal(searchedLineOf(`${TWO}\n\nA later paragraph.`), null);
});

test("withSearchRecord records the line from a search_notes result", async () => {
  const searched = [];
  const result = resultOf(TWO);
  const wrapped = withSearchRecord(async () => result, searched);
  assert.equal(await wrapped("search_notes", { query: "reading list" }), result, "the result passes through unchanged");
  assert.deepEqual(searched, ["Searched: @seyi, @supa, @public-worship, @context-lc, @crystal-care."]);
});

test("withSearchRecord records the line from a search result", async () => {
  const searched = [];
  const wrapped = withSearchRecord(async () => resultOf(WITH_BROKEN), searched);
  await wrapped("search", { query: "guild" });
  assert.deepEqual(searched, ["Searched: @maya-home, @kiln-guild. Not reachable just now, so not searched: @broken."]);
});

test("withSearchRecord ignores a failed search and a non-search tool", async () => {
  const searched = [];
  const failed = withSearchRecord(async () => resultOf(TWO, { isError: true }), searched);
  await failed("search_notes", { query: "reading list" });
  const other = withSearchRecord(async () => resultOf(TWO), searched);
  await other("read_note", { path: "notes/a.md" });
  assert.deepEqual(searched, []);
});

test("withSearchRecord hands back the dispatcher unchanged when there is no record", () => {
  const callTool = async () => resultOf(TWO);
  assert.equal(withSearchRecord(callTool, undefined), callTool);
});

test("withSearchedLine appends the recorded line after a reply that omitted it", () => {
  const searched = ["Searched: @seyi, @supa, @public-worship, @context-lc, @crystal-care."];
  assert.equal(
    withSearchedLine("Nothing on the public worship reading list.", searched),
    "Nothing on the public worship reading list.\n\nSearched: @seyi, @supa, @public-worship, @context-lc, @crystal-care.",
  );
});

test("withSearchedLine trims the reply's trailing space before the line", () => {
  const searched = ["Searched: @a, @b."];
  assert.equal(withSearchedLine("Nothing here.\n  ", searched), "Nothing here.\n\nSearched: @a, @b.");
});

test("withSearchedLine leaves a reply that already has the line unchanged", () => {
  const reply = "Nothing on the public worship reading list.\n\nSearched: @seyi, @supa.";
  assert.equal(withSearchedLine(reply, ["Searched: @seyi, @supa."]), reply);
});

test("withSearchedLine leaves the reply unchanged when nothing was searched", () => {
  assert.equal(withSearchedLine("Nothing here.", []), "Nothing here.");
  assert.equal(withSearchedLine("Nothing here.", undefined), "Nothing here.");
});

test("withSearchedLine leaves a blank reply unchanged", () => {
  assert.equal(withSearchedLine("   ", ["Searched: @a, @b."]), "   ");
  assert.equal(withSearchedLine(undefined, ["Searched: @a, @b."]), undefined);
});

test("withSearchedLine uses the last recorded line", () => {
  const searched = ["Searched: @a, @b.", "Searched: @c, @d."];
  assert.equal(withSearchedLine("Nothing.", searched), "Nothing.\n\nSearched: @c, @d.");
});

// 2026-11-21 (owner's pick): the line goes only beside an answer that says something isn't there. A reply that used a
// search to find a note and then saved it got a stray "Searched: …" text in a live 1:1 chat.
test("withSearchedLine leaves a reply that found what it looked for unchanged", () => {
  const reply = "Saved to the team's meetings inbox: inbox/meetings/2026-11-21-weekly.md. It's team-visible.\n\nhttps://context.lc/note/@team/inbox/meetings/2026-11-21-weekly.md";
  assert.equal(withSearchedLine(reply, ["Searched: @a, @b, @c."]), reply);
  assert.equal(withSearchedLine("The guild reading list has three books: Dune, Emma and Beloved.", ["Searched: @a, @b."]), "The guild reading list has three books: Dune, Emma and Beloved.");
});

test("saysNotThere reads answers that say something isn't there", () => {
  for (const said of [
    "Nothing on the public worship reading list.",
    "I couldn't find a note about the retreat.",
    "I can’t find that email anywhere.",
    "The address isn't in your notes.",
    "There's no record of the November switch.",
    "None of your notes mention Julie.",
    "A search didn't turn one up.",
    "It's not written down anywhere I can read.",
  ]) assert.ok(saysNotThere(said), said);
});

test("saysNotThere passes answers that found what they looked for", () => {
  for (const said of [
    "Saved to Supa's meetings inbox: inbox/meetings/2026-11-21-supa-weekly-steering.md. It's team-visible, so the team can see it. I left out the personal bit.",
    "The transcript is machine-made, so check the names against the recording.",
    "Your Deuteronomy 32 note links the other chapters and the authorship notes.",
    "Doreen's timecard has Wednesday filled in, so there are hours to pay.",
  ]) assert.ok(!saysNotThere(said), said);
});

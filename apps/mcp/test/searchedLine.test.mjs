import assert from "node:assert/strict";
import test from "node:test";
import { searchedLineOf, withSearchedLine, withSearchRecord } from "../src/agent/searchClaims.js";

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

/**
 * The Tex page's Pages list (`http/texPage/pages.js`): every page a chat's
 * turns and jobs wrote, newest first, each once, from the chat's own ledger.
 *
 * Sabotage record (2026-11-10): a failed write listed, a plain note listed,
 * and a `..` path let through each failed the test named for it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { pageName, pageWritten, pagesView } from "../src/http/texPage/pages.js";

const tool = (seq, name, args, ok = true) => ({ seq, kind: "tool", name, args, ok, at: 1_700_000_000_000 + seq });

function ledgerOf(entries) {
  return {
    async read(chat, { before, limit }) {
      const older = entries.filter((entry) => entry.seq < before).sort((a, b) => b.seq - a.seq);
      const page = older.slice(0, limit);
      return { entries: page, ...(older.length > limit ? { before: page.at(-1).seq } : {}) };
    },
  };
}

test("lists each page once, newest first, in the workspace the call named or the chat's own", async () => {
  const ledger = ledgerOf([
    tool(1, "write", { action: "save", path: "trips/lisbon.page.md" }),
    tool(2, "write", { action: "save", path: "notes/plain.md" }),
    tool(3, "write_note", { path: "projects/venues.page.md", context: "@Supa" }),
    tool(4, "write", { action: "save", path: "trips/lisbon.page.md" }),
    tool(5, "fetch", { path: "trips/other.page.md" }),
  ]);
  const { pages } = await pagesView(ledger, "texts", "seyi");
  assert.deepEqual(pages.map((page) => [page.context, page.path, page.title]), [
    ["seyi", "trips/lisbon.page.md", "Lisbon"],
    ["supa", "projects/venues.page.md", "Venues"],
  ]);
  assert.equal(pages[0].at, 1_700_000_000_004);
});

test("a write that failed, an archive, a path that climbs, or no workspace to name is not a page", () => {
  assert.equal(pageWritten(tool(1, "write", { path: "a.page.md" }, false), "seyi"), null);
  assert.equal(pageWritten(tool(1, "write", { action: "archive", path: "a.page.md" }), "seyi"), null);
  assert.equal(pageWritten(tool(1, "write", { path: "../a.page.md" }), "seyi"), null);
  assert.equal(pageWritten(tool(1, "write", { path: "a.page.md" }), ""), null);
  assert.deepEqual(pageWritten(tool(1, "write", { path: "/a.page.md" }), "seyi"), { context: "seyi", path: "a.page.md" });
});

test("reads back through the ledger a page at a time", async () => {
  const entries = Array.from({ length: 1200 }, (_, i) => tool(i + 1, "search_web", { q: "x" }));
  entries[10] = tool(11, "write", { path: "old/plan.page.md" });
  const { pages } = await pagesView(ledgerOf(entries), "texts", "seyi");
  assert.deepEqual(pages.map((page) => page.path), ["old/plan.page.md"]);
});

test("a page's name is its file name in words", () => {
  assert.equal(pageName("projects/100-person-concert.page.md"), "100 person concert");
  assert.equal(pageName("a/sunday_services.page.md"), "Sunday services");
});

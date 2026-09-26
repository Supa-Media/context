/**
 * Status groups: every status is in Not started, In progress or Done, and a
 * folder's words are declared in its front note (`src/lists/statuses.js`,
 * "Status groups" in `docs/decisions/folder-lists.md`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/lists/`, and reverted. Numbers are what
 * actually failed.
 *
 * 1. **`statusListOf` without the per-group default** — 11 failed: every
 *    check that reads a default, down to the defaults being a valid list.
 * 2. **`resolveStatusList` stopping at the folder itself** — 1 failed, the
 *    inheritance check.
 * 3. **`holds` ignoring group names** — 3 failed: `is done`, `is open` and
 *    `is not done`.
 * 4. **`setNoteProperty` writing a list item with a comma** — 1 failed, the
 *    comma refusal.
 */

import { noteProperties, parseListBody, selectListRows, setNoteProperty } from "../src/lists.js";
import {
  compareStatuses,
  defaultStatusList,
  resolveStatusList,
  statusGroupOf,
  statusListOf,
  statusListProblem,
  withStatus,
} from "../src/lists/statuses.js";

const note = (path, updatedAt, properties = {}) => ({ path, updatedAt, properties });
const parse = (...body) => parseListBody(body.join("\n")).config;

export async function runStatusChecks(check) {
  /* ------------------------------- the list ------------------------------- */
  {
    const list = defaultStatusList();
    check("the defaults are no status, in progress and finished", JSON.stringify(list) === JSON.stringify({ "not-started": [], "in-progress": ["in progress"], done: ["finished"] }));
  }
  {
    const list = statusListOf({ "statuses-not-started": ["exploration"], "statuses-done": [] });
    check("a declared group keeps its words", list["not-started"].join() === "exploration");
    check("an empty Done reads as its default, so every group has a status", list.done.join() === "finished");
    check("a missing In progress reads as its default", list["in-progress"].join() === "in progress");
  }
  {
    const list = statusListOf({ "statuses-in-progress": ["Review", "review"], "statuses-done": ["review", "shipped"] });
    check("a word twice is kept once, in its first group", list["in-progress"].join() === "Review" && list.done.join() === "shipped");
  }

  /* ------------------------------- the groups ------------------------------- */
  {
    const list = statusListOf({ "statuses-not-started": ["exploration"], "statuses-done": ["finished", "archived"] });
    check("no status is Not started", statusGroupOf("", list) === "not-started");
    check("a declared word is in its group, whatever the case", statusGroupOf("Exploration", list) === "not-started");
    check("an ordinary word the folder never declared is placed", statusGroupOf("active", list) === "in-progress" && statusGroupOf("shipped", list) === "done");
    check("a word nobody placed is in no group", statusGroupOf("someday maybe", list) === null);
    const drawn = ["done", "someday", "active", "", "In progress", "exploration", "finished", "planned"].sort((a, b) => compareStatuses(a, b, list));
    check(
      "a board runs no status, Not started, In progress, Done, then words in no group",
      drawn.join("|") === "|exploration|planned|In progress|active|finished|done|someday",
    );
  }

  /* ------------------------------- inheritance ------------------------------- */
  {
    const notes = [
      note("1-projects/overview.md", 1, { "statuses-in-progress": ["doing", "in review"] }),
      note("1-projects/web/overview.md", 1, { status: "doing" }),
      note("1-projects/clients/overview.md", 1, { "statuses-done": ["won", "lost"] }),
      note("index.md", 1, { "statuses-done": ["never"] }),
    ];
    const web = resolveStatusList("1-projects/web", notes);
    check("a folder with no list inherits its parent's", web.from === "1-projects" && web.list["in-progress"].join() === "doing,in review");
    const clients = resolveStatusList("1-projects/clients", notes);
    check("a folder's own list replaces its parent's whole", clients.from === "1-projects/clients" && clients.list.done.join() === "won,lost" && clients.list["in-progress"].join() === "in progress");
    const root = resolveStatusList("elsewhere", notes);
    check("the workspace's front page never declares a list", root.from === null && root.list.done.join() === "finished");
  }

  /* ------------------------------- editing ------------------------------- */
  {
    const list = defaultStatusList();
    const moved = withStatus(withStatus(list, "In review", "in-progress"), "in review", "done", 0);
    check("adding a word moves it out of any other group", moved["in-progress"].join() === "in progress" && moved.done.join() === "in review,finished");
    check("a list that empties Done is refused", /Done needs/.test(statusListProblem({ ...list, done: [] }) ?? ""));
    check("a word with a comma is refused", /comma/.test(statusListProblem({ ...list, done: ["a, b"] }) ?? ""));
    check("a word twice is refused", /already/.test(statusListProblem({ ...list, done: ["In progress"] }) ?? ""));
    check("the defaults are a valid list", statusListProblem(list) === null);
  }

  /* ---------------------------- writing a list ---------------------------- */
  {
    const text = "---\ntitle: Projects\n---\nBody\n";
    const written = setNoteProperty(text, "statuses-done", ["finished", "won"]);
    check("a list is written inline", written.text === "---\ntitle: Projects\nstatuses-done: [finished, won]\n---\nBody\n");
    check("…and reads back as the list", noteProperties(written.text)["statuses-done"].join() === "finished,won");
    const empty = setNoteProperty(written.text, "statuses-done", []);
    check("an empty list is written as []", /statuses-done: \[\]/.test(empty.text) && noteProperties(empty.text)["statuses-done"].length === 0);
    check("an item with a comma is refused", /comma/.test(setNoteProperty(text, "statuses-done", ["a, b"]).error ?? ""));
    const block = "---\nstatuses-done:\n  - finished\n  - won\nowner: Ada\n---\n";
    check("a block list is replaced whole", setNoteProperty(block, "statuses-done", ["lost"]).text === "---\nstatuses-done: [lost]\nowner: Ada\n---\n");
  }

  /* ------------------------------ list blocks ------------------------------ */
  {
    const notes = [
      note("p/overview.md", 1, { "statuses-done": ["won", "lost"] }),
      note("p/a.md", 1, { status: "won" }),
      note("p/b.md", 2, { status: "active" }),
      note("p/c.md", 3, {}),
      note("p/d.md", 4, { status: "lost" }),
      note("p/e.md", 5, { status: "someday" }),
    ];
    const titles = (config) => selectListRows(config, notes, { selfPath: "p/overview.md" }).rows.map((row) => row.title).sort().join();
    check("status is done matches every word in the folder's Done", titles(parse("from: p", "where: status is done")) === "a,d");
    check("status is open matches Not started and In progress, with a status", titles(parse("from: p", "where: status is open")) === "b");
    check("status is not done keeps the rest", titles(parse("from: p", "where: status is not done")) === "b,c,e");
    check("a literal word still matches itself", titles(parse("from: p", "where: status is won")) === "a");
  }
  {
    const notes = [
      note("q/one/overview.md", 1, { status: "in progress" }),
      note("q/one/a.md", 1, { status: "finished" }),
      note("q/one/b.md", 1, { status: "active" }),
    ];
    const { rows } = selectListRows(parse("from: q", "rows: projects"), notes);
    check("progress counts a default Done word as finished", rows[0]?.progress?.done === 1 && rows[0].progress.total === 2);
  }
}

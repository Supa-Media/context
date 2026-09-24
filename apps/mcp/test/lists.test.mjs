/**
 * Folder lists: the ```list fence, and choosing which notes it shows.
 *
 * A list block is a query a person writes into any note — a projects page, a
 * blog index — and every surface that draws it (the editor, a shared page, a
 * website) must read the same grammar and pick the same rows. So the grammar
 * and the row selection are pure functions, checked here without a worker.
 *
 * Two properties matter most. **The grammar fails closed**, like forms: a
 * block that does not parse draws its error, never a best-guess list. And
 * **selection never widens what the caller passed in**: it only filters,
 * sorts and trims the notes it is given, so whatever the caller already
 * hid (privacy, a draft) stays hidden — and plumbing under `.context/` and the
 * note holding the block are never listed.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/lists/`, and reverted. Numbers are what
 * actually failed.
 *
 * 1. **The subfolder test removed from `select.js`** — 6 checks failed: the
 *    subfolder check itself and five orderings that a nested note joined.
 * 2. **`renderListBlock` dropping `limit`** — 1 failed, the round-trip.
 * 3. **The hidden-segment test removed from `select.js`** — 2 failed, both
 *    with subfolders on. With subfolders off the subfolder rule already
 *    hides `.context/`, which is why the tampered-config check exists: it
 *    proves the plumbing rule, not the subfolder rule, is what holds.
 */

import {
  LIST_FENCE_LANG,
  parseListBlocks,
  parseListBody,
  renderListBlock,
  selectListRows,
  noteProperties,
} from "../src/lists.js";

const block = (...body) => ["```list", ...body, "```"].join("\n");
const parse = (...body) => parseListBlocks(block(...body))[0];

const NOTES = [
  { path: "1-projects/website.md", updatedAt: 300, properties: { status: "active", owner: "Seyi", title: "Website folder" } },
  { path: "1-projects/mobile.md", updatedAt: 500, properties: { status: "active", owner: "Ada", tags: ["ios", "Expo"] } },
  { path: "1-projects/old.md", updatedAt: 900, properties: { status: "done", owner: "Seyi" } },
  { path: "1-projects/idea.md", updatedAt: 100, properties: {} },
  { path: "1-projects/deep/nested.md", updatedAt: 700, properties: { status: "active" } },
  { path: "1-projects/index.md", updatedAt: 50, properties: {} },
  { path: "1-projects/.context/cache.md", updatedAt: 999, properties: { status: "active" } },
  { path: "1-projects-archive/x.md", updatedAt: 800, properties: { status: "active" } },
  { path: "1-projects/photo.png", updatedAt: 800, properties: {} },
];

export async function runListChecks(check) {
  /* ------------------------------ the grammar ------------------------------ */
  check("the fence language is `list`", LIST_FENCE_LANG === "list");
  check("a note with no list block has none", parseListBlocks("# Hi\n\n```js\nlist\n```\n").length === 0);

  {
    const full = parse(
      "from: 1-projects/",
      "where: status is active",
      "sort: updated, newest first",
      "show: owner, updated"
    );
    const c = full.config;
    check("a well-formed list block parses", !!c && !full.error);
    check("...and its folder loses the trailing slash", c.from === "1-projects");
    check(
      "...and its condition is read",
      c.where.length === 1 && c.where[0].property === "status" && c.where[0].op === "is" && c.where[0].value === "active"
    );
    check("...and its sort is read", c.sort.key === "updated" && c.sort.order === "desc");
    check("...and its columns are read in order", c.show.join() === "owner,updated");
    check("...and the block's line is reported", full.line === 1);
  }

  {
    const c = parse("from: blog").config;
    check("defaults: newest first by last save", c.sort.key === "updated" && c.sort.order === "desc");
    check("defaults: no conditions, no columns", c.where.length === 0 && c.show.length === 0);
    check("defaults: 50 rows, subfolders left out", c.limit === 50 && c.subfolders === false);
    check("a property sort defaults to A to Z", parse("from: blog", "sort: title").config.sort.order === "asc");
    check("sort directions read as words", parse("from: blog", "sort: priority, z to a").config.sort.order === "desc");
    check("oldest first is ascending", parse("from: blog", "sort: updated, oldest first").config.sort.order === "asc");
  }

  {
    const c = parse("from: 1-projects", "where: status is not done and owner is set", "where: tags contains ios").config;
    check(
      "conditions join with `and`, across lines too",
      c.where.map((w) => `${w.property} ${w.op} ${w.value ?? ""}`.trim()).join(" | ") ===
        "status is not done | owner is set | tags contains ios"
    );
    const quoted = parse("from: x", 'where: title is "Rock and roll"', 'where: state is "set"').config;
    check("a quoted value keeps its `and`", quoted.where[0].value === "Rock and roll");
    check("a quoted `set` is a value, not the set test", quoted.where[1].op === "is" && quoted.where[1].value === "set");
    check("`is not set` is the missing test", parse("from: x", "where: owner is not set").config.where[0].op === "is not set");
  }

  {
    const err = (...body) => parse(...body).error || "";
    check("a block without `from` is refused", /"from" is required/.test(err("where: a is b")));
    check("an unknown key is refused by name", /unknown key "colour"/.test(err("from: x", "colour: red")));
    check("a key other than `where` is refused twice", /"from" is set twice/.test(err("from: x", "from: y")));
    check("a line that is not key: value is refused by line", /line 2/.test(err("from: x", "status is active")));
    check("a folder climbing out with .. is refused", /folder/.test(err("from: ../secrets")));
    check("an absolute folder is refused", /folder/.test(err("from: /1-projects")));
    check("a plumbing folder is refused", /folder/.test(err("from: .context/collaboration")));
    check("an empty folder is refused", /folder/.test(err("from:")));
    check("a condition without an operator is refused", /condition/.test(err("from: x", "where: status active")));
    check("a condition without a value is refused", /condition/.test(err("from: x", "where: status is")));
    check("an unclosed quote is refused", /quote/.test(err("from: x", 'where: title is "open')));
    check("an unknown sort direction is refused", /sort/.test(err("from: x", "sort: title, sideways")));
    check("more than four columns are refused", /at most 4/.test(err("from: x", "show: a, b, c, d, e")));
    check("a repeated column is refused", /twice/.test(err("from: x", "show: a, a")));
    check("a limit over 100 is refused", /limit/.test(err("from: x", "limit: 101")));
    check("a limit that is not a number is refused", /limit/.test(err("from: x", "limit: lots")));
    check("subfolders takes yes or no", /subfolders/.test(err("from: x", "subfolders: maybe")));
    check(
      "an unclosed list fence is an error, not a list of the rest of the note",
      /never closed/.test(parseListBlocks("```list\nfrom: x\n")[0].error || "")
    );
    check(
      "a list fence quoted inside another fence is not a block",
      parseListBlocks("````md\n```list\nfrom: x\n```\n````\n").length === 0
    );
  }

  {
    const text = [
      "from: 1-projects",
      'where: status is not done and title is "Rock and roll"',
      "where: owner is set",
      "sort: priority, z to a",
      "show: owner, updated",
      "limit: 10",
      "subfolders: yes",
    ];
    const config = parseListBody(text.join("\n")).config;
    const rendered = renderListBlock(config);
    check("a config renders back to a block that parses to the same config", JSON.stringify(parseListBody(rendered).config) === JSON.stringify(config));
    check("defaults are not written out", renderListBlock(parse("from: blog").config) === "from: blog");
  }

  /* ------------------------------ the rows ------------------------------ */
  {
    const rows = selectListRows(parse("from: 1-projects").config, NOTES, { selfPath: "1-projects/index.md" });
    const paths = rows.rows.map((r) => r.path);
    check("rows are the folder's notes, newest first", paths.join() === "1-projects/old.md,1-projects/mobile.md,1-projects/website.md,1-projects/idea.md");
    check("a note in a subfolder is left out by default", !paths.includes("1-projects/deep/nested.md"));
    check("the note holding the block is never listed", !paths.includes("1-projects/index.md"));
    check("plumbing under .context/ is never listed", !paths.some((p) => p.includes(".context")));
    check("a sibling folder sharing the prefix is not the folder", !paths.includes("1-projects-archive/x.md"));
    check("attachments are not notes", !paths.includes("1-projects/photo.png"));
    check("a row's title is its title property", rows.rows[2].title === "Website folder");
    check("...or its file name", rows.rows[0].title === "old");
  }

  {
    const withSub = selectListRows(parse("from: 1-projects", "subfolders: yes").config, NOTES, {}).rows.map((r) => r.path);
    check("subfolders: yes takes the whole subtree", withSub.includes("1-projects/deep/nested.md"));
    check("...but still never plumbing", !withSub.some((p) => p.includes(".context")));
  }

  {
    const pick = (...where) =>
      selectListRows(parse("from: 1-projects", ...where.map((w) => `where: ${w}`), "sort: title").config, NOTES, {}).rows.map((r) => r.title).join();
    check("`is` matches case-insensitively", pick("status is ACTIVE") === "mobile,Website folder");
    check("`is not` keeps notes without the property", pick("status is not active") === "idea,index,old");
    check("`is` on a list matches an item", pick("tags is expo") === "mobile");
    check("`contains` matches part of a value", pick("owner contains sey") === "old,Website folder");
    check("`is set` needs a value", pick("owner is set") === "mobile,old,Website folder");
    check("`is not set` is the rest", pick("owner is not set") === "idea,index");
    check("conditions all have to hold", pick("status is active", "owner is Seyi") === "Website folder");
  }

  {
    const config = parse("from: 1-projects", "sort: owner", "show: owner, updated", "limit: 2").config;
    const result = selectListRows(config, NOTES, {});
    check("a property sort puts missing values last", result.rows.map((r) => r.title).join() === "mobile,old");
    check("the limit trims and says so", result.rows.length === 2 && result.total === 5 && result.truncated === true);
    check(
      "columns carry the property and the save time",
      result.rows[0].values[0].key === "owner" && result.rows[0].values[0].value === "Ada" && result.rows[0].values[1].value === 500
    );
  }

  {
    const tampered = selectListRows({ from: "", where: [], sort: { key: "updated", order: "desc" }, show: [], limit: 50, subfolders: true }, NOTES, {});
    check("a config that skipped the parser still never lists plumbing", !tampered.rows.some((r) => r.path.includes(".context")));
  }

  /* ------------------------ frontmatter as properties ------------------------ */
  {
    const p = noteProperties(
      [
        "---",
        "title: \"Launch: part two\"",
        "status: active",
        "tags: [ios, 'Expo']",
        "people:",
        "  - Ada",
        "  - Seyi",
        "team:",
        "  owner: Sayo",
        "updated: 2026-09-24T10:30",
        "__proto__: polluted",
        "---",
        "# Body",
        "status: not this",
      ].join("\n")
    );
    check("a quoted scalar loses its quotes and keeps its colon", p.title === "Launch: part two");
    check("an inline list is a list", Array.isArray(p.tags) && p.tags.join() === "ios,Expo");
    check("a block list is a list", Array.isArray(p.people) && p.people.join() === "Ada,Seyi");
    check("a nested map is skipped, not flattened", p.owner === undefined);
    check("a value with a colon survives", p.updated === "2026-09-24T10:30");
    check("the body is not frontmatter", p.status === "active");
    check("a key named __proto__ is only a key", p.__proto__ === "polluted" && ({}).polluted === undefined);
    check("a note without frontmatter has no properties", Object.keys(noteProperties("# Hi\nstatus: x")).length === 0);
    check("an unclosed block is not frontmatter", Object.keys(noteProperties("---\nstatus: x\n")).length === 0);
  }
}

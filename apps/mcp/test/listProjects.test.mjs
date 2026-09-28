/**
 * Folder lists of projects: `rows: projects`, `group`, `as: board`.
 *
 * A project is anything with a `status`: a note, or a folder whose front note
 * has one. Its sub-projects are found the same way one level down, and never
 * deeper. See `src/lists/projects.js` and `docs/decisions/folder-lists.md`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/lists/`, and reverted. Numbers are what
 * actually failed.
 *
 * 1. **`projectsIn` accepting a folder with no front note** — 4 failed: the
 *    no-front-note check, the project count, the group order and the limit.
 * 2. **The plumbing filter removed from `selectProjectRows`** — 2 failed, both
 *    `updated` checks: a save under `.context/` became the project's newest.
 * 3. **`progress` counting only shown sub-projects** — 1 failed, the filtered
 *    progress check.
 * 4. **`compareGroups` dropping the lifecycle order** — 2 failed, both group
 *    orders.
 */

import {
  noteHeading,
  parseListBody,
  renderEvaluatedListBlocks,
  renderListBlock,
  selectListRows,
} from "../src/lists.js";

const parse = (...body) => parseListBody(body.join("\n"));
const note = (path, updatedAt, properties = {}, heading) => ({ path, updatedAt, properties, ...(heading ? { heading } : {}) });

const NOTES = [
  // A folder project with sub-projects: two notes and a folder.
  note("1-projects/web/overview.md", 100, { status: "active", owner: "Seyi" }, "Website folder"),
  note("1-projects/web/renderer.md", 400, { status: "done", owner: "Seyi" }, "Public renderer"),
  note("1-projects/web/members.md", 200, { status: "active", owner: "Seyi's Codex" }),
  note("1-projects/web/list-block/overview.md", 150, { status: "planned", owner: "any agent" }),
  note("1-projects/web/list-block/deep/idea.md", 900, { status: "active" }),
  note("1-projects/web/agent-alignment.md", 600, {}),
  note("1-projects/web/.context/cache.md", 5000, { status: "active" }),
  // Front note order: overview beats README.
  note("1-projects/domains/README.md", 50, { status: "done" }),
  note("1-projects/domains/overview.md", 60, { status: "paused", owner: "Sayo", title: "Custom domains" }),
  // A one-note project.
  note("1-projects/incident.md", 700, { status: "done", owner: "Seyi" }),
  // Not projects: a folder with no front note, a note with no status, plumbing.
  note("1-projects/backlog/thing.md", 800, { status: "active" }),
  note("1-projects/idea.md", 300, {}),
  note("1-projects/.context/hidden/overview.md", 999, { status: "active" }),
  note("1-projects/untitled/overview.md", 10, { status: "Active" }),
  note("1-projects/README.md", 5, {}),
  note("elsewhere/x/overview.md", 1000, { status: "active" }),
];

export async function runProjectListChecks(check) {
  /* ------------------------------ the grammar ------------------------------ */
  {
    const { config } = parse("from: 1-projects", "rows: projects", "group: status", "as: board");
    check("rows, group and as parse", config?.rows === "projects" && config.group === "status" && config.as === "board");
    check("a config of projects renders back to itself", JSON.stringify(parseListBody(renderListBlock(config)).config) === JSON.stringify(config));
    const plain = parse("from: 1-projects").config;
    check("defaults: notes, no group, a list", plain.rows === "notes" && plain.group === null && plain.as === "list");
    check("defaults are left out when rendered", renderListBlock(plain) === "from: 1-projects");
  }
  check("rows takes notes or projects", /"rows" takes/.test(parse("from: a", "rows: tasks").error ?? ""));
  check("as takes list or board", /"as" takes/.test(parse("from: a", "group: status", "as: table").error ?? ""));
  check("a board needs a group", /needs "group"/.test(parse("from: a", "as: board").error ?? ""));
  check("group must be a property name", /"group" needs/.test(parse("from: a", "group: two words").error ?? ""));
  check("group cannot be title", /"group" needs/.test(parse("from: a", "group: title").error ?? ""));
  check("subfolders does not apply to projects", /does not apply/.test(parse("from: a", "rows: projects", "subfolders: yes").error ?? ""));

  /* ---------------------------- what a project is ---------------------------- */
  const cfg = (...extra) => parse("from: 1-projects", "rows: projects", ...extra).config;
  {
    const { rows, total } = selectListRows(cfg("show: owner, updated"), NOTES, { selfPath: "1-projects/README.md" });
    const titles = rows.map((row) => row.title);
    check("a folder whose front note has a status is a project", titles.includes("Website folder"));
    check("a note with a status is a project", titles.includes("incident"));
    check("a folder with no front note is not a project", !titles.includes("backlog") && !titles.includes("thing"));
    check("a note with no status is not a project", !titles.includes("idea"));
    check("plumbing is never a project", !rows.some((row) => row.path.includes(".context")));
    check("another folder's projects are not listed", !rows.some((row) => row.path.startsWith("elsewhere/")));
    check("exactly the four projects are counted", total === 4 && rows.length === 4);

    const web = rows.find((row) => row.title === "Website folder");
    check("a folder project opens its front note", web.path === "1-projects/web/overview.md" && web.kind === "folder" && web.folder === "1-projects/web");
    check("a folder project's updated is its newest save inside", web.values.find((v) => v.key === "updated").value === 900);
    check("a hidden save does not bump a project's updated", web.values.find((v) => v.key === "updated").value !== 5000);
    const incident = rows.find((row) => row.title === "incident");
    check("a note project is a note", incident.kind === "note" && incident.folder === undefined);

    const domains = rows.find((row) => row.path.startsWith("1-projects/domains/"));
    check("overview.md is the front note before README.md", domains.path === "1-projects/domains/overview.md" && domains.title === "Custom domains");
    check("a title property names the project before its heading", domains.title === "Custom domains");
    check("with neither, the folder name does", rows.some((row) => row.title === "untitled"));

    const kids = web.children.map((child) => child.title).sort();
    check("sub-projects are the notes and folders inside with a status", kids.join("|") === "Public renderer|list-block|members");
    check("the parent's own front note is not its sub-project", !web.children.some((child) => child.path === "1-projects/web/overview.md"));
    check("nothing deeper than one level is a sub-project", !web.children.some((child) => child.path.includes("/deep/")));
    check("sub-projects have no sub-projects of their own", web.children.every((child) => child.children === undefined));
    check("a sub-folder is a folder row", web.children.find((child) => child.title === "list-block").kind === "folder");
    check("progress counts closed sub-projects", web.progress.done === 1 && web.progress.total === 3);
    check("a note project has no progress", incident.progress === null && incident.children.length === 0);
  }

  /* ------------------------ filters keep parents with children ------------------------ */
  {
    const { rows } = selectListRows(cfg('where: owner is "Seyi\'s Codex"'), NOTES);
    check("a parent is kept when a sub-project matches", rows.length === 1 && rows[0].title === "Website folder");
    check("it carries only the matching sub-projects", rows[0].children.length === 1 && rows[0].children[0].title === "members");
    check("progress still counts every sub-project", rows[0].progress.total === 3 && rows[0].progress.done === 1);
  }
  {
    const { rows } = selectListRows(cfg("where: status is not done"), NOTES);
    check("a filter applies to projects themselves", !rows.some((row) => row.title === "incident"));
    const web = rows.find((row) => row.title === "Website folder");
    check("…and hides the finished sub-projects under a kept parent", !web.children.some((child) => child.title === "Public renderer"));
  }

  /* --------------------------------- grouping --------------------------------- */
  {
    const { rows } = selectListRows(cfg("group: status"), NOTES);
    const groups = [...new Set(rows.map((row) => row.group))];
    check("groups run in lifecycle order", groups.join("|") === "active|paused|done");
    check("values that differ by case share a group", rows.filter((row) => row.group === "active").length === 2);
  }
  {
    const notes = [
      note("p/a.md", 1, { status: "zeta" }),
      note("p/b.md", 2, {}),
      note("p/c.md", 3, { status: "alpha" }),
      note("p/d.md", 4, { status: "done" }),
    ];
    const { rows } = selectListRows(parse("from: p", "group: status").config, notes);
    // Status has its own groups (statuses.js): No status is Not started, so first; words in no group follow Done.
    check("a list of notes grouped by status: no status, then done, then unplaced words a to z", rows.map((row) => row.group).join("|") === "|done|alpha|zeta");
  }
  {
    const { rows, truncated, total } = selectListRows(cfg("group: owner", "limit: 2"), NOTES);
    check("limit counts projects and says the rest exist", rows.length === 2 && truncated === true && total === 4);
  }

  /* ------------------------------ headings ------------------------------ */
  check("a heading after frontmatter is the note's heading", noteHeading("---\nstatus: a\n---\n\n# Website folder\n") === "Website folder");
  check("a heading inside a code fence is not", noteHeading("```\n# not this\n```\n# This") === "This");
  check("a note with no heading has none", noteHeading("just text") === null);
  check("an unclosed frontmatter has no heading", noteHeading("---\n# x") === null);

  /* ------------------------------ public pages ------------------------------ */
  {
    const markdown = "```list\nfrom: 1-projects\nrows: projects\ngroup: status\nshow: owner\n```";
    const rendered = await renderEvaluatedListBlocks(markdown, async (config) => selectListRows(config, NOTES));
    check("a grouped list prints each group as a heading", rendered.includes("**active**") && rendered.includes("**done**"));
    check("a project list names its first column Project", rendered.includes("| Project | owner |"));
    check("sub-projects print under their parent", /Website folder \(1\/3\).*\n\| ↳ /.test(rendered));
  }
}

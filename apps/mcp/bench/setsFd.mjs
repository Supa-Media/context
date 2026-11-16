/**
 * THE FRONT DOOR ALONE ON ITS UNIT TESTS (Dev2, 2026-11-16: the Dev set's twenty Front door tests all came back
 * "can't run alone"; "YES" to making them run). A Front door test is one person's text in a test conversation with
 * its must and never lines. It runs as a whole turn, because the Front door's answer is the turn's: the bench's
 * invented world for that person (`world.mjs`: their notes, a scripted web, no real mail or texts), the chat before
 * the text posted to its ledger first (`- earlier person:` / `- earlier tex:`, as a Lab replay does), then the one
 * text, answered by the tree's own code and config, and the judge grades the answer on its must and never lines
 * (`coreArea.mjs` `runTests`: `pnpm ai run`, then `pnpm ai judge`).
 *
 * The setup. A Lab run writes the draft's graph into the tree's `texConfig.json`, and Tex's models, efforts and
 * prompt words come only from that config (`production.js`, since PRs #3268 and #3272), so the run answers as the
 * draft. The live setup note in Context adds the search, web and step settings and the task skills; a tree the replay
 * gate pulled it into uses it, and any other gets `LIVE_SETTINGS` below, the same settings without the task skills,
 * whose words live only in Context. A test that needs a task skill says so in its own words, never silently.
 *
 * What runs: a one-to-one chat whose person has a world in the bench (a test file runs as them), on a plain text or a
 * reply. A group chat, a picture or an edit says why it can't yet, on its row.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The live setup note's settings, without its task skills (Context `@context-lc ai/production/texting-assistant.md`). */
export const LIVE_SETTINGS = ["job: texting-assistant", "max_steps: 24", "open_web: yes", "search:", "  everywhere: true"].join("\n");

/** The most chat lines posted before a test's text: Tex's history reads at most about this much anyway. */
export const MAX_EARLIER = 200;

const FRONT = /^---\n([\s\S]*?)\n---/;

/** A test conversation's lines before message `i`, as the chat's ledger takes them: texts and replies, the person's and Tex's. */
export function earlierLines(c, i) {
  const lines = [];
  for (const m of c.msgs.slice(0, i)) {
    if (m.kind && m.kind !== "reply") continue; // a tapback, an edit or an unsend is not a line of the chat's text
    if (typeof m.text !== "string" || m.text.trim() === "") continue;
    lines.push({ from: m.tex ? "tex" : "person", text: m.text });
  }
  return lines.slice(-MAX_EARLIER);
}

/** Why message `i` of `c` can't run as a Front door test yet, or null when it can. */
export function cantRun(c, i) {
  const m = c.msgs[i];
  if (c.kind === "group") return "a group chat's Front door test can't run alone yet: only one-to-one chats run in the bench world";
  if (m.kind && m.kind !== "reply") return `a ${m.kind} can't run as a Front door test: only a text or a reply`;
  if (Array.isArray(m.pics) && m.pics.length > 0) return "a text with pictures can't run as a Front door test yet";
  if (typeof m.text !== "string" || m.text.trim() === "") return "the text is empty";
  if (!Array.isArray(c.members) || typeof c.members[0] !== "string") return "the conversation names no person";
  return null;
}

/** One bench test of `units` (all one person's): the front matter given, then one case a unit, its chat before it. */
export function fdTest(units, front) {
  const out = [`---\n${front}\n---\n\n# Sets\n\nThe Front door's unit tests from the test conversations (\`setsFd.mjs\`).\n`];
  units.forEach((u, k) => {
    const m = u.convo.msgs[u.at];
    const l = u.label;
    const lines = [
      `## ${k + 1}. ${String(m.text).replace(/\s+/g, " ").slice(0, 120)}`,
      "",
      "- kind: task",
      `- person texts: ${JSON.stringify(m.text)}`,
      ...earlierLines(u.convo, u.at).map((line) => `- earlier ${line.from}: ${JSON.stringify(line.text)}`),
      ...(l.must || []).map((x) => `- must: ${x}`),
      ...(l.never || []).map((x) => `- must not: ${x}`),
    ];
    out.push(lines.join("\n") + "\n");
  });
  return out.join("\n");
}

/**
 * The front matter a person's tests run with: the bench test that runs as them (`run_as:`), the core set first, with its
 * day, judge and voice lines; one run each, on the scripted web. Null when no test runs as them.
 */
export async function frontFor(dir, person) {
  const names = (await readdir(join(dir, "tests"))).filter((n) => n.endsWith(".md")).sort((a, b) => (a === "core.md" ? -1 : b === "core.md" ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const front = FRONT.exec(await readFile(join(dir, "tests", name), "utf8"))?.[1];
    if (!front || !new RegExp(`^run_as: ${person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(front)) continue;
    if (!/^today: /m.test(front)) continue;
    let f = front.replace(/^runs: .*$/m, "runs: 1").replace(/^web: .*$/m, "web: scripted");
    if (!/^runs: /m.test(f)) f += "\nruns: 1";
    if (!/^web: /m.test(f)) f += "\nweb: scripted";
    return f;
  }
  return null;
}

/**
 * The Front door's batch: every unit through the tree's own bench, grouped by person, each group one test. `runTests`
 * is `coreArea.mjs`'s from the tree, swapped by a test. Answers one row a unit.
 */
export async function runFd(units, { tree, fake = false, runTests = null }) {
  const rows = [];
  const can = [];
  for (const u of units) {
    const why = cantRun(u.convo, u.at);
    if (why) rows.push({ ...u.row, right: false, ran: false, usd: 0, why });
    else can.push(u);
  }
  if (can.length === 0) return rows;
  const run = runTests ?? (await import(pathToFileURL(join(tree, "apps/mcp/bench/coreArea.mjs")).href)).runTests;
  const scratch = await mkdtemp(join(tmpdir(), "tex-sets-fd-"));
  try {
    const dir = join(scratch, "ai");
    await cp(join(tree, "apps/mcp/bench/ai"), dir, { recursive: true });
    const setup = join(dir, "setups", "texting-assistant");
    const pulled = await readFile(join(setup, "production.md"), "utf8").then(() => true, () => false);
    if (!pulled) {
      await rm(setup, { recursive: true, force: true });
      await mkdir(setup, { recursive: true });
      await writeFile(join(setup, "production.md"), `---\n${LIVE_SETTINGS}\n---\n\nTex's rules are its prompt modules, read from Tex's config.\n`);
    }
    const byPerson = new Map();
    for (const u of can) {
      const person = u.convo.members[0];
      if (!byPerson.has(person)) byPerson.set(person, []);
      byPerson.get(person).push(u);
    }
    const tests = [];
    for (const [person, group] of byPerson) {
      const front = await frontFor(dir, person);
      if (front === null) {
        rows.push(...group.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: `no bench world runs as ${person}: a test in apps/mcp/bench/ai/tests/ needs run_as: ${person} and a today: line` })));
        continue;
      }
      const name = `sets-${tests.length + 1}`;
      await writeFile(join(dir, "tests", `${name}.md`), fdTest(group, front));
      tests.push({ name, group });
    }
    if (tests.length === 0) return rows;
    const got = await run(tree, tests.map((t) => t.name), { dir, scratch, tag: "sets", fake });
    const each = got.usd / tests.reduce((n, t) => n + t.group.length, 0);
    for (const t of tests) {
      t.group.forEach((u, k) => {
        const r = got.rows.find((x) => x.id === `${t.name}/q${k + 1}`);
        const usd = Math.round(each * 10_000) / 10_000;
        if (!r) rows.push({ ...u.row, right: false, ran: false, usd, why: "the bench gave no judged answer" });
        else rows.push({ ...u.row, right: Boolean(r.right), ran: true, usd, got: r.right ? "every line held" : "a must or never line failed", want: "every must and never line" });
      });
    }
    return rows;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

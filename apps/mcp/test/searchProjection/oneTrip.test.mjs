/**
 * Words in one trip, and the word being typed (the search tune-up, Dev2's
 * pick, 2026-10-27).
 *
 * A search asked the strict expression, waited, and on a miss asked the
 * relaxed one: two round trips from our server to Cloudflare, each 0.14 to
 * 1.1 s, for every query holding a word nobody wrote. And the strict
 * expression matched whole words only, so "weekly meet" found nothing until
 * the person finished typing "meeting". Both are checked here against real
 * FTS5 (`fixtures.mjs`), counting requests the way the stub records them.
 *
 * Sabotage record (temporary local edits, reverted, as measured):
 *   `toTypingMatchExpression` returning `toMatchExpression`
 *       → "the word being typed…", "one word asks once…" and an endToEnd
 *         check fail (3)
 *   the prefix applied to a last word of any length
 *       → "a last word of two letters…" fails (1)
 */

import {
  DESCRIPTOR,
  answerFromProjection,
  createD1Backend,
  createD1Client,
  createSearchBudget,
  noteStore,
  projectPass,
} from "./fixtures.mjs";
import { toTypingMatchExpression } from "../../src/search/d1/query.js";

const READ = /^\s*SELECT[\s\S]*FROM notes_(private|team)_fts/i;

export async function runOneTripChecks(check) {
  const notes = {
    "projects/weekly.md": "# Weekly meeting\n\nThe leadership weekly meeting notes.\n",
    "projects/budget.md": "# Budget\n\nNumbers for the quarter.\n",
    "areas/me.md": "# Me\n\nA note about meerkats.\n",
  };
  const backend = createD1Backend();
  const client = createD1Client(DESCRIPTOR, { fetchImpl: (url, init) => backend.handle(url, init) });
  await projectPass(noteStore(notes), client, {
    census: new Map(Object.keys(notes).map((path) => [path, "v1"])),
    visibilityOf: () => "team",
    budget: createSearchBudget(400),
  });

  const ask = async (query, tier = "private") => {
    const before = backend.requests.length;
    const answer = await answerFromProjection(client, { query, tier, isVisible: () => true, missIsAnswer: true });
    const reads = backend.requests.slice(before).filter((request) => READ.test(request.sql));
    return { answer, reads, paths: answer.hits.map((hit) => hit.key) };
  };

  const typing = await ask("weekly meet");
  check(
    "the word being typed matches the start of a longer word",
    typing.paths.length === 1 && typing.paths[0] === "projects/weekly.md" && !typing.answer.hits[0].loose,
  );
  check("and a strict hit costs one request", typing.reads.length === 1);

  check(
    "the words before it are whole words, not starts",
    (await ask("wee meeting")).answer.hits.every((hit) => hit.loose === true),
  );

  const short = await ask("me");
  check(
    "a last word of two letters stays exact rather than matching half the context",
    short.paths.length === 1 && short.paths[0] === "areas/me.md",
  );

  // Nothing holds both words; the any-word retry finds the budget note, and
  // rode in the same request as the strict half.
  const missed = await ask("budget zebra");
  check(
    "a miss costs one request too: the any-word retry travels with the strict half",
    missed.paths.includes("projects/budget.md") &&
      missed.answer.hits.every((hit) => hit.loose === true) &&
      missed.reads.length === 1 &&
      missed.reads[0].batch === 4,
  );

  const team = await ask("budget zebra", "team");
  check(
    "a team caller's one request names the team table alone, both halves",
    team.reads.length === 1 &&
      team.reads[0].batch === 2 &&
      team.reads[0].sql.includes("notes_team_fts") &&
      !team.reads[0].sql.includes("notes_private_fts"),
  );

  check(
    "one word asks once, since its retry would ask the same thing",
    (await ask("budget")).reads[0].batch === 2,
  );
  check(
    "the typing expression is null wherever the strict one is",
    toTypingMatchExpression("") === null && toTypingMatchExpression("  !! ") === null,
  );
  backend.close();
}

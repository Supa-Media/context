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
    "a miss costs one request too: the any-word retry and the name search travel with the strict half",
    missed.paths.includes("projects/budget.md") &&
      missed.answer.hits.every((hit) => hit.loose === true) &&
      missed.reads.length === 1 &&
      missed.reads[0].batch === 6,
  );

  const team = await ask("budget zebra", "team");
  check(
    "a team caller's one request names the team table alone, all three asks",
    team.reads.length === 1 &&
      team.reads[0].batch === 3 &&
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

  // A question in a person's words: only the transcript holds "where do we", so the strict half finds it alone, and
  // the question's own words (keep, spare, key), asked in the same request, find the note that answers it too.
  const askedNotes = {
    "home/keys.md": "# Keys\n\nKofi keeps the spare key in the kitchen tin.\n",
    "meetings/house.md": "# House meeting\n\nWhere do we keep the spare key? I forgot again.\n",
    "home/bins.md": "# Bins\n\nWhere do we put the recycling.\n",
  };
  const askedBackend = createD1Backend();
  const askedClient = createD1Client(DESCRIPTOR, { fetchImpl: (url, init) => askedBackend.handle(url, init) });
  await projectPass(noteStore(askedNotes), askedClient, {
    census: new Map(Object.keys(askedNotes).map((path) => [path, "v1"])),
    visibilityOf: () => "team",
    budget: createSearchBudget(400),
  });
  const before = askedBackend.requests.length;
  const asked = await answerFromProjection(askedClient, { query: "where do we keep the spare key", tier: "private", isVisible: () => true, missIsAnswer: true });
  const askedReads = askedBackend.requests.slice(before).filter((request) => READ.test(request.sql));
  const askedPaths = asked.hits.map((hit) => hit.key);
  check(
    "an asked question finds the note that answers it beside the transcript that quotes it, as strict hits",
    askedPaths.includes("home/keys.md") && askedPaths.includes("meetings/house.md") && !askedPaths.includes("home/bins.md") && asked.hits.every((hit) => hit.loose !== true),
  );
  check("and its own words ride in the same request", askedReads.length === 1);
  const none = await answerFromProjection(askedClient, { query: "where do we keep the zebra", tier: "private", isVisible: () => true, missIsAnswer: true });
  check(
    "where no note holds every word, the any-word retry over every word stands, as before",
    none.hits.length > 0 && none.hits.every((hit) => hit.loose === true),
  );
  askedBackend.close();

  // The archive is left out in the query itself, so archived chunks never take the row cap from live notes; a search
  // inside the archive keeps them. `archive-2024/` is an ordinary folder.
  const archNotes = {
    "archive/old.md": "# Old\n\nThe zebra plan.\n",
    "4-Archive/older.md": "# Older\n\nThe zebra plan again.\n",
    "archive-2024/kept.md": "# Kept\n\nA zebra note.\n",
    "projects/live.md": "# Live\n\nThe zebra plan now.\n",
  };
  const archBackend = createD1Backend();
  const archClient = createD1Client(DESCRIPTOR, { fetchImpl: (url, init) => archBackend.handle(url, init) });
  await projectPass(noteStore(archNotes), archClient, {
    census: new Map(Object.keys(archNotes).map((path) => [path, "v1"])),
    visibilityOf: () => "team",
    budget: createSearchBudget(400),
  });
  const regular = (await answerFromProjection(archClient, { query: "zebra", tier: "private", isVisible: () => true, missIsAnswer: true })).hits.map((hit) => hit.key).sort();
  check("regular search asks no archived chunk", JSON.stringify(regular) === JSON.stringify(["archive-2024/kept.md", "projects/live.md"]));
  const inArchive = (await answerFromProjection(archClient, { query: "zebra", prefix: "archive/", tier: "private", isVisible: () => true, missIsAnswer: true })).hits.map((hit) => hit.key);
  check("a search inside the archive finds it", JSON.stringify(inArchive) === JSON.stringify(["archive/old.md"]));
  archBackend.close();
}

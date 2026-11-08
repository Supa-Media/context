/**
 * A note whose name answers the question leads the word hits (`search/named.js`), against real SQL.
 *
 * The real-search check of 2026-11-04 asked "why I started Context" and the
 * note `why-context-started.page.md` was not in the answer: transcripts holding
 * every common word many times outranked it, and "started" is in its file name
 * alone. These checks stand up the same shape.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `liftNamed` returning the hits unchanged           → "a note named with the question leads…" and "a name holding most…" fail
 *   the name search asked of every chunk, not ord 0    → "a long note asks the name search once…" fails
 *   NAMED_MIN_TERMS lowered to 1                        → "one shared word is not a name match" and four `oneTrip` checks fail
 *   names lifted where no note held every word          → nothing here fails (the order is the same in this corpus);
 *                                                          the search benchmark's q54 ("book club snack rules") does
 */

import { DESCRIPTOR, answerFromProjection, createD1Backend, createD1Client, createSearchBudget, noteStore, projectPass } from "./fixtures.mjs";

const transcript = (n) =>
  `# Weekly call ${n}\n\n${Array.from({ length: 40 }, () => "Why I think we started talking about context again, and why it started late. How we position against other AI memory tools. Context context.").join("\n\n")}\n`;

export async function runNamedChecks(check) {
  const notes = {
    "meetings/call-1.md": transcript(1),
    "meetings/call-2.md": transcript(2),
    "meetings/call-3.md": transcript(3),
    "yc/why-context-started.page.md": "# Context began as a notebook\n\nI built it so my AI tools could read my notes. Context grew from there.\n",
    "products/positioning.md": "# Context positioning\n\nWho this is for, and how the product is described against Obsidian.\n",
    "products/tools.md": "# Tools\n\nContext has tools. AI memory is one of the things people compare.\n",
  };
  const backend = createD1Backend();
  const client = createD1Client(DESCRIPTOR, { fetchImpl: (url, init) => backend.handle(url, init) });
  await projectPass(noteStore(notes), client, {
    census: new Map(Object.keys(notes).map((path) => [path, "v1"])),
    visibilityOf: () => "team",
    budget: createSearchBudget(400),
  });
  const ask = async (query) => {
    const answer = await answerFromProjection(client, { query, tier: "team", isVisible: () => true, missIsAnswer: true });
    return { answer, paths: answer.hits.map((hit) => hit.key) };
  };

  const started = await ask("why I started Context");
  check("a note named with the question leads the word hits, above transcripts holding every word", started.paths[0] === "yc/why-context-started.page.md");
  check("and the transcripts still follow it", started.paths.includes("meetings/call-1.md"));

  const position = await ask("how we position Context against other AI memory tools");
  check(
    "a name holding most of the question's words is a word hit, not a loose one, though the note lacks some words",
    position.paths[0] === "products/positioning.md" && position.answer.hits[0].loose === undefined,
  );

  const one = await ask("weekly budget");
  const nothingWhole = await ask("context positioning zebra");
  check(
    "where no note holds every word nothing is lifted: the any-word order stands and every hit is loose",
    nothingWhole.answer.hits.length > 0 && nothingWhole.answer.hits.every((hit) => hit.loose === true),
  );

  check("one shared word is not a name match: a note named only 'weekly' is not lifted by it", one.paths.length === 0 || one.answer.hits.every((hit) => hit.loose === true));

  const before = backend.requests.length;
  await ask("started context");
  const sent = backend.requests.slice(before).map((request) => request.sql ?? "").join("\n");
  check("a long note asks the name search once: the name search reads first chunks alone", /\{title headings\}/.test(sent) === false && /ord = 0/.test(sent));
  backend.close();
}

/**
 * `remembered`: the line an agent's `remember` calls make. See
 * activity.test.mjs for the module overview and docs/design/remember for the
 * feature. One line per app per working stretch, counting facts rather than
 * notes, across folders, and never carrying the fact itself.
 */

import { applyEntry, change, claude, describeEntry, entryFor, iso, parseFile, renderFile } from "./fixtures.mjs";

const FACT = "Prefers short replies and hates the word synergy.";

function remembered(path, at, actor = claude) {
  return entryFor(change("remember_fact", [path], { fact: FACT, kind: "stated", count: 1 }, actor, at));
}

export async function runActivityRememberedChecks(check) {
  const first = remembered("3-resources/working-preferences.md", iso(0));
  check("remember_fact is a line", first !== null && first.kind === "remembered");

  // Three facts: two in one note, one in a note in another folder.
  const three = [
    remembered("3-resources/working-preferences.md", iso(0)),
    remembered("3-resources/working-preferences.md", iso(60_000)),
    remembered("2-areas/about-sayo.md", iso(2 * 60_000)),
  ].reduce((entries, entry) => applyEntry(entries, entry) || entries, []);
  check("one app's facts across folders are one line", three.length === 1);
  check("and the line counts facts, not notes", three[0].n === 3);
  check("and names both notes", three[0].paths.length === 2);

  const otherApp = applyEntry(three, remembered("2-areas/about-sayo.md", iso(3 * 60_000), { name: "@sayo", client: "ChatGPT" }));
  check("another app's facts are their own line", otherApp.length === 2);

  const nextDay = applyEntry(three, remembered("2-areas/about-sayo.md", iso(7 * 60 * 60_000)));
  check("past the working stretch, a new line", nextDay.length === 2);

  const sentence = describeEntry(three[0]);
  check("the sentence says remembered and the count", /remembered 3 facts/.test(sentence));

  const file = renderFile(three, "");
  check("the fact never reaches the line", !file.includes("synergy") && !sentence.includes("synergy"));
  const parsed = parseFile(file);
  check("a remembered line reads back", parsed.length === 1 && parsed[0].kind === "remembered" && parsed[0].n === 3);
}

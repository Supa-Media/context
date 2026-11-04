/**
 * The other forms of an English word a search should also find: "meetings" finds a note about a meeting, "planned"
 * finds "plan" and "planning" (the search revamp, 2026-11-04: "accurate search … something like google search is the
 * bar").
 *
 * Asked on the query side, as an OR of word forms, rather than by stemming the index (`porter` in FTS5): a stemmed
 * index stores "format" for "formation", so a search typed as far as "formatio" would match nothing while the person
 * is still typing, and every index would have to be built again. Here the index keeps the words as written, a word
 * typed in full also asks its forms, and the last word typed still matches as the start of a longer word.
 *
 * Plain rules, not a dictionary: a suffix taken off (`ies`, `es`, `s`, `ing`, `ed`, `er`), a doubled last letter
 * undone ("running" → "run"), an `e` put back ("making" → "make"), and the usual suffixes put on the root. A form
 * that is not a word matches nothing and costs nothing. Only words of four or more Latin letters are expanded, so a
 * short word, a number or a word in another script means only itself.
 */

const LATIN_WORD = /^[a-z]{4,}$/;
const MAX_FORMS = 12;

function roots(word) {
  const out = new Set([word]);
  const strip = (suffix, add = "") => {
    if (!word.endsWith(suffix)) return;
    const root = word.slice(0, -suffix.length);
    if (add) {
      if (root.length >= 3) out.add(root + add);
      return;
    }
    // A root of four letters or more stands as a word; a shorter one only with its `e` put back ("making" → "make"),
    // or its doubled last letter undone ("running" → "run"), so "this" never asks "thing" and "news" never "new".
    if (root.length >= 4) out.add(root);
    if (root.length >= 3 && /[b-df-hj-np-tv-z]$/.test(root) && (suffix === "ing" || suffix === "ed" || suffix === "er")) out.add(`${root}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(root) && !/(ll|ss|zz|ff)$/.test(root) && root.length >= 4) out.add(root.slice(0, -1));
  };
  strip("ies", "y");
  strip("ied", "y");
  if (/(ss|x|z|ch|sh)es$/.test(word)) strip("es");
  if (!word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) strip("s");
  strip("ing");
  strip("ed");
  strip("er");
  return out;
}

/**
 * `word` and its other forms, `word` first. A word that is not four or more Latin letters is returned alone.
 *
 * @param {string} word
 * @returns {string[]}
 */
export function wordForms(word) {
  const lower = typeof word === "string" ? word.toLowerCase() : "";
  if (!LATIN_WORD.test(lower)) return [word];
  const forms = new Set([lower]);
  const found = roots(lower);
  // A word with a suffix taken off grows its forms from its roots, never from itself ("meetings" never asks
  // "meetingses"); a root that is only a step on the way ("plann", "studi") is not one.
  const bases = [...found].filter((root) => (found.size === 1 || root !== lower) && !/i$/.test(root) && !(/([b-df-hj-np-tv-z])\1$/.test(root) && found.has(root.slice(0, -1))));
  for (const root of bases) {
    forms.add(root);
    for (const suffix of ["s", "es", "ing", "ed"]) {
      if (suffix === "es" ? !/(s|x|z|ch|sh)$/.test(root) : suffix === "s" && /(s|x|z|ch|sh)$/.test(root)) continue;
      forms.add(root.endsWith("e") && (suffix === "ing" || suffix === "ed") ? `${root.slice(0, -1)}${suffix}` : `${root}${suffix}`);
    }
    if (root.endsWith("y") && root.length >= 4) forms.add(`${root.slice(0, -1)}ies`);
  }
  return [...forms].filter((form) => form.length >= 3).slice(0, MAX_FORMS);
}

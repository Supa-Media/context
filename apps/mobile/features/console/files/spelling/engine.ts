/**
 * The dictionary: is a word spelled right, and what might it have meant.
 *
 * Hunspell dictionaries read by `nspell` (MIT), the same files LibreOffice and
 * Firefox ship, so the checker is the familiar one rather than a list of our
 * own. Everything runs on the person's own device; nothing typed is sent
 * anywhere to be checked (board 5, 2026-10-27).
 *
 * `nspell`'s own suggestions miss the commonest typing slips — it offers
 * "ten" and "tea" for `teh` and never "the" — so `suggest` puts the words one
 * keystroke away first: two letters swapped, a letter dropped, one too many, one
 * wrong. Those are checked against the same dictionary, so nothing is offered
 * that it would underline. `nspell`'s list follows for everything else.
 */

import nspell from "nspell";

export interface Speller {
  /** True for a word the dictionary accepts as typed. */
  correct(word: string): boolean;
  /** Up to `limit` replacements, the likeliest first. Empty for a correct word. */
  suggest(word: string, limit?: number): string[];
}

/** Lookups remembered per speller. A note re-checks the same words on every keystroke. */
const CACHE_LIMIT = 20_000;

/** Long words make the one-edit search large and are rarely mistyped by one key. */
const EDIT_SEARCH_MAX = 24;

export function createSpeller(aff: string, dic: string): Speller {
  const dictionary = nspell(aff, dic);
  const answers = new Map<string, boolean>();
  const letters = alphabetOf(aff);

  const lookup = (word: string): boolean => {
    const known = answers.get(word);
    if (known !== undefined) return known;
    // Hunspell already accepts a sentence's capital and the possessive of a word it knows.
    const answer = dictionary.correct(word);
    if (answers.size >= CACHE_LIMIT) answers.clear();
    answers.set(word, answer);
    return answer;
  };

  return {
    correct: lookup,
    suggest(word, limit = 5) {
      if (lookup(word)) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      const offer = (candidate: string) => {
        if (out.length >= limit || seen.has(candidate) || candidate === word) return;
        seen.add(candidate);
        out.push(candidate);
      };
      for (const candidate of oneKeyAway(word, letters)) {
        if (lookup(candidate)) offer(matchCase(word, candidate));
        if (out.length >= limit) return out;
      }
      for (const candidate of dictionary.suggest(word)) offer(matchCase(word, candidate));
      return out;
    },
  };
}

/**
 * Words one edit from `word`, in the order people make the mistakes.
 *
 * Swapped neighbours first (`teh`, `recieve`), then a missing letter
 * (`elevn`), then a doubled or stray one, then one wrong letter. Within a
 * kind, left to right.
 */
function* oneKeyAway(word: string, letters: string): Generator<string> {
  if (word.length > EDIT_SEARCH_MAX) return;
  const lower = word.toLowerCase();
  for (let i = 0; i < lower.length - 1; i++) {
    if (lower[i] === lower[i + 1]) continue;
    yield lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
  }
  for (let i = 0; i <= lower.length; i++) {
    for (const letter of letters) yield lower.slice(0, i) + letter + lower.slice(i);
  }
  for (let i = 0; i < lower.length; i++) yield lower.slice(0, i) + lower.slice(i + 1);
  for (let i = 0; i < lower.length; i++) {
    for (const letter of letters) {
      if (letter !== lower[i]) yield lower.slice(0, i) + letter + lower.slice(i + 1);
    }
  }
}

/**
 * The letters a language's words are made of, from its affix file's `TRY`
 * line — the list Hunspell itself tries, in the order it tries them. Plain
 * a–z when a file has none.
 */
function alphabetOf(aff: string): string {
  const line = /^TRY\s+(\S+)/mu.exec(aff);
  const letters = (line?.[1] ?? "esianrtolcdugmphbyfvkwzxjq").replace(/[^\p{Ll}]/gu, "");
  return [...new Set(letters)].join("");
}

/**
 * A suggestion in the case the word was typed in: `Recieve` at the start of a
 * sentence is offered `Receive`. A dictionary word that carries its own
 * capitals (`Israelite`, `iPhone`) keeps them.
 */
function matchCase(typed: string, candidate: string): string {
  if (candidate !== candidate.toLowerCase()) return candidate;
  const first = typed.charAt(0);
  if (first !== first.toLowerCase() && typed.slice(1) === typed.slice(1).toLowerCase()) {
    return candidate.charAt(0).toUpperCase() + candidate.slice(1);
  }
  return candidate;
}

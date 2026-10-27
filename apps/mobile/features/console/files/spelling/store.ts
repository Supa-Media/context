/**
 * The person's spelling settings and the loaded dictionary, in one place every
 * open editor reads.
 *
 * A module-level store rather than props, for the reason `appearance.ts` is
 * one: the choice is the person's, not one screen's, and the editor is built
 * once and has notes swapped through it — threading three more props from the
 * account down through `NoteEditor` into a view that never rebuilds would be a
 * longer way to reach the same object. `useSpellingSync` (mounted at the root)
 * writes the account's copy in; `extension.ts` subscribes and redraws.
 *
 * ## What lives on the account and what does not
 *
 * On (Settings › Spelling, board 4): whether checking is on, the language, and
 * the words the person taught it — so a word added on the phone stops being
 * red on the Mac. A copy is kept on the device so the first note opened paints
 * with the right words before the account answers; the account is the truth
 * (the in-app-messages rule: never on the device alone).
 *
 * Not on the account: "Ignore in this note", which lasts until the note is
 * closed and lives in the editor's own state (`extension.ts`).
 *
 * ## When there is no dictionary
 *
 * The files are fetched from this origin the first time a note is opened
 * (`/spelling/<language>.aff|.dic`, built by `scripts/build-drawing-editor.mjs`
 * beside the drawing editor). Until they arrive — or if they never do, offline
 * on a first visit — `status` says so and the editor hands the job back to
 * the browser's own checker, which is what it had before. Nothing goes silent.
 */

import { createSpeller, type Speller } from "./engine";

export const SPELLING_LANGUAGES = [
  { key: "en-US", label: "English (US)" },
  { key: "en-GB", label: "English (UK)" },
] as const;

export type SpellingLanguage = (typeof SPELLING_LANGUAGES)[number]["key"];

/** The longest word the account keeps; the server refuses longer. */
export const MAX_WORD_LENGTH = 64;

export interface SpellingPrefs {
  enabled: boolean;
  language: SpellingLanguage;
  /** Words the person added, as typed. Matched case-insensitively. */
  words: readonly string[];
}

export type SpellingStatus = "loading" | "ready" | "failed" | "off";

export interface SpellingSnapshot extends SpellingPrefs {
  status: SpellingStatus;
  /** The dictionary for `language`, once loaded. */
  speller: Speller | null;
  /** `words`, lower-cased, for lookups. */
  known: ReadonlySet<string>;
}

/** What saves a change on the account. Absent while nobody is signed in. */
export interface SpellingSaver {
  learn(word: string): Promise<unknown>;
  forget(word: string): Promise<unknown>;
  setEnabled(enabled: boolean): Promise<unknown>;
  setLanguage(language: SpellingLanguage): Promise<unknown>;
}

const DEVICE_KEY = "context.spelling.v1";

let prefs: SpellingPrefs = readDeviceCopy() ?? { enabled: true, language: deviceLanguage(), words: [] };
let snapshot: SpellingSnapshot = derive(prefs, null, prefs.enabled ? "loading" : "off");
let saver: SpellingSaver | null = null;
const listeners = new Set<() => void>();
const spellers = new Map<SpellingLanguage, Promise<Speller>>();

/** The loader, replaceable so a test can hand over a dictionary without a network. */
let fetchDictionary: (language: SpellingLanguage) => Promise<{ aff: string; dic: string }> = defaultFetch;

export function getSpelling(): SpellingSnapshot {
  return snapshot;
}

export function subscribeSpelling(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when `word` should not be underlined: the dictionary or the person knows it. */
export function isKnownWord(state: SpellingSnapshot, word: string): boolean {
  const lowered = word.toLowerCase();
  if (state.known.has(lowered)) return true;
  // A word the person added is known in its possessive too: `Kayode's`.
  if (lowered.endsWith("'s") && state.known.has(lowered.slice(0, -2))) return true;
  return state.speller === null || state.speller.correct(word);
}

/** The account's copy, in. Called by `useSpellingSync` whenever it changes. */
export function applyAccountSpelling(next: SpellingPrefs): void {
  setPrefs(next);
}

/** Wire the account up (or take it away, with `null`, on sign-out). */
export function setSpellingSaver(next: SpellingSaver | null): void {
  saver = next;
}

/**
 * Teach the checker a word, everywhere: shown at once, saved on the account.
 *
 * Optimistic because the person is looking at the red line they just asked to
 * go away. If the account refuses, the next account answer puts the list back
 * the way the server has it — the account stays the truth.
 */
export function learnWord(word: string): void {
  const clean = word.trim();
  if (clean === "" || clean.length > MAX_WORD_LENGTH) return;
  if (!snapshot.known.has(clean.toLowerCase())) setPrefs({ ...prefs, words: [...prefs.words, clean] });
  void saver?.learn(clean).catch(() => undefined);
}

export function forgetWord(word: string): void {
  const lowered = word.toLowerCase();
  setPrefs({ ...prefs, words: prefs.words.filter((known) => known.toLowerCase() !== lowered) });
  void saver?.forget(word).catch(() => undefined);
}

export function setSpellingEnabled(enabled: boolean): void {
  setPrefs({ ...prefs, enabled });
  void saver?.setEnabled(enabled).catch(() => undefined);
}

export function setSpellingLanguage(language: SpellingLanguage): void {
  setPrefs({ ...prefs, language });
  void saver?.setLanguage(language).catch(() => undefined);
}

/** Tests only: a dictionary from somewhere other than the network, and a clean slate. */
export function resetSpellingForTests(loader?: (language: SpellingLanguage) => Promise<{ aff: string; dic: string }>): void {
  fetchDictionary = loader ?? defaultFetch;
  spellers.clear();
  saver = null;
  prefs = { enabled: true, language: "en-US", words: [] };
  snapshot = derive(prefs, null, "loading");
  listeners.clear();
}

/** Start loading the current language's dictionary, if it is not already. Idempotent. */
export function ensureDictionary(): void {
  if (!prefs.enabled) return;
  const language = prefs.language;
  if (snapshot.speller !== null && snapshot.language === language) return;
  let pending = spellers.get(language);
  if (pending === undefined) {
    pending = fetchDictionary(language).then(({ aff, dic }) => createSpeller(aff, dic));
    spellers.set(language, pending);
    // A failed fetch is forgotten, so the next note opened tries again.
    pending.catch(() => spellers.delete(language));
  }
  pending.then(
    (speller) => {
      if (prefs.language !== language || !prefs.enabled) return;
      publish(derive(prefs, speller, "ready"));
    },
    () => {
      if (prefs.language !== language || !prefs.enabled) return;
      publish(derive(prefs, null, "failed"));
    },
  );
}

function setPrefs(next: SpellingPrefs): void {
  prefs = next;
  writeDeviceCopy(next);
  if (!next.enabled) {
    publish(derive(next, null, "off"));
    return;
  }
  const sameLanguage = snapshot.language === next.language && snapshot.speller !== null;
  publish(derive(next, sameLanguage ? snapshot.speller : null, sameLanguage ? "ready" : "loading"));
  if (!sameLanguage && listeners.size > 0) ensureDictionary();
}

function publish(next: SpellingSnapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function derive(from: SpellingPrefs, speller: Speller | null, status: SpellingStatus): SpellingSnapshot {
  return { ...from, speller, status, known: new Set(from.words.map((word) => word.toLowerCase())) };
}

async function defaultFetch(language: SpellingLanguage): Promise<{ aff: string; dic: string }> {
  if (typeof fetch !== "function") throw new Error("no fetch");
  const get = async (ext: string) => {
    const response = await fetch(`/spelling/${language}.${ext}`);
    if (!response.ok) throw new Error(`dictionary ${language}.${ext}: ${response.status}`);
    return response.text();
  };
  const [aff, dic] = await Promise.all([get("aff"), get("dic")]);
  return { aff, dic };
}

/** English as the device reads it: British spelling where the device is set to it. */
function deviceLanguage(): SpellingLanguage {
  const spoken = typeof navigator === "undefined" ? "" : navigator.language ?? "";
  return /^en-(GB|IE|AU|NZ|ZA|IN)\b/iu.test(spoken) ? "en-GB" : "en-US";
}

function readDeviceCopy(): SpellingPrefs | null {
  try {
    const raw = globalThis.localStorage?.getItem(DEVICE_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<SpellingPrefs>;
    const language = SPELLING_LANGUAGES.some((option) => option.key === parsed.language)
      ? (parsed.language as SpellingLanguage)
      : deviceLanguage();
    const words = Array.isArray(parsed.words) ? parsed.words.filter((word): word is string => typeof word === "string") : [];
    return { enabled: parsed.enabled !== false, language, words };
  } catch {
    return null;
  }
}

function writeDeviceCopy(next: SpellingPrefs): void {
  try {
    globalThis.localStorage?.setItem(DEVICE_KEY, JSON.stringify(next));
  } catch {
    // A private window or full storage: the account still has it.
  }
}

/**
 * A folder page's chaos line ("14 things in here · calm is 4 or 5"), kept and
 * read ahead like the rest of the page (`folderPage/pageCache.ts`).
 *
 * Owner, 2026-10-17, from a second phone recording: the line was asked for by
 * the page itself once it was on screen, so it arrived a beat later and pushed
 * the description and the list down under the person's eyes, and did it again
 * on every visit. Now the press that opens a folder asks for it, the phone
 * keeps the page it is on until the answer is here (`BrowsePane`), and a page
 * seen before draws its line at once and asks again behind it.
 *
 * Keyed by the asking function, which is one per workspace (`useChaosScore`),
 * so one workspace's answers are never drawn in another. Memory only.
 */

import type { ChaosFolder, ChaosScore } from "./chaosModel";

export type AskFolder = (folder: string) => Promise<ChaosScore | null>;

/** Folders kept per workspace: a phone walks a few hundred at most in a session. */
const MAX_KEPT = 400;

let lines = new WeakMap<AskFolder, Map<string, ChaosFolder | null>>();
let reading = new WeakMap<AskFolder, Map<string, Promise<ChaosFolder | null>>>();
let generation = 0;
const listeners = new Set<() => void>();
let version = 0;

function linesOf(ask: AskFolder): Map<string, ChaosFolder | null> {
  let kept = lines.get(ask);
  if (kept === undefined) {
    kept = new Map();
    lines.set(ask, kept);
  }
  return kept;
}

function readingOf(ask: AskFolder): Map<string, Promise<ChaosFolder | null>> {
  let going = reading.get(ask);
  if (going === undefined) {
    going = new Map();
    reading.set(ask, going);
  }
  return going;
}

/** Forget everything, beside `forgetPageCache`: nothing read under one session is drawn in the next. */
export function forgetFolderLines(): void {
  lines = new WeakMap();
  reading = new WeakMap();
  generation += 1;
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeFolderLines(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function folderLinesVersion(): number {
  return version;
}

/** The folder's line as last answered: `null` is "no line" (a calm folder, or no score), `undefined` is not asked yet. */
export function cachedFolderLine(ask: AskFolder | undefined, folder: string): ChaosFolder | null | undefined {
  return ask === undefined ? undefined : lines.get(ask)?.get(folder);
}

/** Ask for the folder's line, one question at a time per folder; `fresh` asks again even when one is on its way. */
export function readFolderLine(ask: AskFolder, folder: string, fresh = false): Promise<ChaosFolder | null> {
  const going = readingOf(ask);
  const asked = going.get(folder);
  if (asked !== undefined && !fresh) return asked;
  const started = generation;
  const read = ask(folder)
    .then((answer) => (answer !== null && answer.available ? answer.folder : null))
    .catch(() => null)
    .then((line) => {
      if (started === generation) {
        const kept = linesOf(ask);
        kept.delete(folder);
        kept.set(folder, line);
        if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
        version += 1;
        for (const listener of [...listeners]) listener();
      }
      return line;
    })
    .finally(() => {
      if (going.get(folder) === read) going.delete(folder);
    });
  going.set(folder, read);
  return read;
}

/** Ask ahead of opening the folder (a press on its row), unless the answer is already here. */
export function preloadFolderLine(ask: AskFolder | undefined, folder: string): void {
  if (ask === undefined || cachedFolderLine(ask, folder) !== undefined) return;
  void readFolderLine(ask, folder);
}

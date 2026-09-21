/**
 * Getting a note, or a whole folder, out of Context and onto a disk.
 *
 * ## Why there was nothing here
 *
 * Non-negotiable #1: the customer owns the content and can always leave with
 * it, and that exit is "never gated, never degraded, and never behind a
 * paywall". Every part of that was built except the last step somebody
 * actually takes — the console could read a note and could not hand it to you.
 * Getting your own writing out meant opening the bucket somewhere else, which
 * is a true exit and a poor one: it asks a person to hold cloud credentials to
 * read what they wrote.
 *
 * ## The fetching lives here, apart from React
 *
 * One `collect` function taking the two reads it needs as arguments, so the
 * batching, the `deferred` loop, its bound and what it does with a note it
 * cannot read are all checkable without a Convex client — which matters most
 * for the bound, because the alternative to a bound is a console that hangs on
 * a folder somebody cannot fully read.
 *
 * ## What lands in the archive is what the person can see
 *
 * `notePaths` and `readNotes` are both `minimum: "member"` and both filtered by
 * the live privacy manifest, so a folder download carries exactly the notes
 * that caller could open one at a time. A note held back is absent, and absent
 * the same way it is absent from the listing — the download is not a second
 * answer to "what may I read", it is the first answer, in bulk.
 */

import { buildZip, type ZipEntry } from "./zip";

/**
 * One note, as `files.readNotes` answers.
 *
 * A structural mirror of the server's `notesValidator` rather than an import
 * of it: that validator is a Convex value, not a type, and the alternative is
 * a cast at the call site — which throws away checking at exactly the seam
 * where the two sides could drift. What is mirrored is deliberately the whole
 * union, so a fourth outcome added there is a type error here rather than a
 * note silently dropped from somebody's archive.
 */
export type ReadResult =
  | { path: string; outcome: "read"; note: { text: string; etag?: string } }
  | { path: string; outcome: "error"; code: string; message: string }
  | { path: string; outcome: "deferred" };

/**
 * How many rounds of `deferred` to follow before giving up.
 *
 * `readNotes` defers whatever does not fit in one batch's byte budget, so a
 * folder of large notes needs several rounds. The bound is what stops a server
 * that keeps deferring the same path from spinning the console for ever: each
 * round is required to make progress, and a round that reads nothing ends it.
 * Generous, because it is a backstop rather than a pacing mechanism — fifty
 * paths a round, so this reaches five thousand notes.
 */
const MAX_ROUNDS = 100;

/**
 * How many paths one `readNotes` call may name.
 *
 * `READ_BATCH_PATHS` on the server, which refuses a longer list **before** it
 * opens the bucket — so asking for more is a round trip spent learning a
 * number that is already written down. Restated here rather than imported
 * because this module is the console's and that constant is a server
 * implementation detail, and `a batch the server will accept` has a check of
 * its own: a server that lowered its limit would redden that check rather than
 * failing a person's download.
 */
export const READ_BATCH = 50;

export interface CollectOutcome {
  entries: ZipEntry[];
  /** Paths that could not be read, so the caller can say how many. */
  missed: string[];
}

/**
 * Read every one of these notes, following `deferred` until nothing moves.
 *
 * `readBatch` is `files.readNotes` in the console and a stub in the checks.
 * `batchSize` matches the server's own `READ_BATCH_PATHS`; asking for more is
 * refused before the bucket is opened, which is a round trip spent on nothing.
 */
export async function collectNotes(
  paths: readonly string[],
  readBatch: (paths: string[]) => Promise<readonly ReadResult[]>,
  options: { batchSize?: number } = {},
): Promise<CollectOutcome> {
  const batchSize = Math.max(1, options.batchSize ?? READ_BATCH);
  const entries: ZipEntry[] = [];
  const missed: string[] = [];
  let pending = [...paths];

  for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round += 1) {
    const deferred: string[] = [];
    let readThisRound = 0;

    for (let at = 0; at < pending.length; at += batchSize) {
      const batch = pending.slice(at, at + batchSize);
      const results = await readBatch(batch);
      const answered = new Set<string>();
      for (const result of results) {
        answered.add(result.path);
        if (result.outcome === "read") {
          entries.push({ path: result.path, bytes: new TextEncoder().encode(result.note.text) });
          readThisRound += 1;
          continue;
        }
        if (result.outcome === "deferred") {
          deferred.push(result.path);
          continue;
        }
        // An error is a note this caller cannot read, or one that has gone.
        // Counted and left out rather than failing the archive: a folder of
        // two hundred notes must not be undeliverable because of one.
        missed.push(result.path);
      }
      /*
        A path the server did not mention at all. It cannot be retried — a
        round that asked and got silence would ask again for ever — so it is
        counted as missed, which is what the caller tells the person.
      */
      for (const path of batch) {
        if (!answered.has(path)) missed.push(path);
      }
    }

    // Progress, or stop. A server that defers the same paths without ever
    // reading one is not going to start.
    if (readThisRound === 0) {
      missed.push(...deferred);
      pending = [];
      break;
    }
    pending = deferred;
  }
  missed.push(...pending);

  // Stable order, so two downloads of one folder produce the same archive and
  // a diff between them is about the notes.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, missed };
}

/**
 * Every visible note inside this folder, from the context's full path list.
 *
 * **`""` is the context itself**, and it returns everything — which is not an
 * edge case bolted on but the one non-negotiable #1 names out loud:
 * "downloading everything ... is free, identical on both plans, and still
 * works after they cancel". The root breadcrumb is where somebody asks for it,
 * and it is the same archive as any other folder's, one level up.
 */
export function pathsUnder(paths: readonly string[], folder: string): string[] {
  if (folder === "" || folder === "/") return [...paths];
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return paths.filter((path) => path.startsWith(prefix));
}

/**
 * What the person is told once the file has been handed over.
 *
 * The count is the notes in the archive. **Images embedded in them are not**:
 * an attachment lives under Context-owned plumbing keyed by its leaf rather
 * than inside the folder, so it is not among the paths a folder download is
 * about. That is a gap rather than a decision and it is named here instead of
 * being discovered — an archive somebody keeps should not be quietly missing
 * the pictures.
 */
export function downloadNotice(
  kind: "file" | "folder",
  count: number,
  missed: number,
): string {
  if (kind === "file") return "Downloaded.";
  const notes = count === 1 ? "1 note" : `${count} notes`;
  if (missed === 0) return `Downloaded ${notes}.`;
  // Said plainly rather than swallowed: an archive that is quietly short is
  // the worst outcome on an exit path, because nobody finds out until the
  // bucket is gone.
  const left = missed === 1 ? "1 could not be read" : `${missed} could not be read`;
  return `Downloaded ${notes}; ${left} and ${missed === 1 ? "is" : "are"} not in the archive.`;
}

export { buildZip };

/**
 * The privacy mirror: `privacy.md`'s rules as the tree keeps them
 * (`nodePrivacy`, `table.ts`).
 *
 * Why the tree holds rules at all in phase 1: the tree must answer "who may
 * see this key" exactly as the bucket does. It does so by handing the
 * unchanged `syncManifest` a `privacy.md` rendered from these rules
 * (`parity.ts`), and the parity check compares what the mirror says with what
 * the file says. A rule the mirror lost, or dropped on a parse, is caught
 * there rather than as a leak later.
 *
 * Only the rules are kept. The prose around the managed block is the
 * customer's text, and CLAUDE.md keeps note content out of the control plane.
 */

import { renderPrivacyRulesBlock, type PrivacyRule, type Visibility } from "../privacy";
import { loadPrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";
import type { NodeSink, PrivacyMirror } from "./table";

/** What the mirror reads: only the bucket's `get`. */
export type MirrorSource = Pick<FileStore, "get">;

/**
 * A `privacy.md` that will not parse. Rendering an invalid mirror as this (no
 * managed block at all) makes the rendered file parse invalid too, so the
 * listing a mirror serves fails closed exactly as the bucket's file does.
 */
const UNPARSEABLE = "privacy.md is not parseable\n";

/**
 * The mirror of the bucket's `privacy.md` as it is now.
 *
 * `loadPrivacyState` is the one reader every privacy decision uses, so the
 * mirror inherits its fail-closed answers: a missing file is no rules (and no
 * etag), and an unparseable one is `invalid` with no rules.
 */
export async function privacyMirrorOf(store: MirrorSource): Promise<PrivacyMirror> {
  // `loadPrivacyState` reads nothing but `get`, so the narrower type is honest.
  const state = await loadPrivacyState(store as FileStore);
  return {
    ...(state.etag === null ? {} : { etag: state.etag }),
    invalid: state.invalid,
    folders: state.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
    notes: [...state.overrides].map(([path, visibility]) => ({ path, visibility })),
  };
}

/**
 * Re-read `privacy.md` and store what it says. The stamp is taken before the
 * read, so a read that races a newer observation of the file loses to it
 * (`privacyIsNewer`), never the other way round.
 */
export async function refreshPrivacyMirror(
  store: MirrorSource,
  sink: Pick<NodeSink, "savePrivacy">,
  now: () => number,
): Promise<void> {
  const at = now();
  await sink.savePrivacy(await privacyMirrorOf(store), at);
}

/**
 * A `privacy.md` whose managed block parses back to the mirror's rules and
 * exceptions. `null` when the mirror has no etag, which is the same as no file.
 *
 * Only the block is rendered, not the prose around it: the mirror never had
 * the prose, and `loadPrivacyState` reads the rules from the block alone.
 */
export function renderMirror(mirror: PrivacyMirror): string | null {
  if (mirror.etag === undefined) return null;
  if (mirror.invalid) return UNPARSEABLE;
  const rules: PrivacyRule[] = mirror.folders.map((folder) => ({
    prefix: folder.prefix,
    vis: folder.visibility as Visibility,
  }));
  const overrides = new Map<string, Visibility>(
    mirror.notes.map((note): [string, Visibility] => [note.path, note.visibility as Visibility]),
  );
  return renderPrivacyRulesBlock(rules, overrides);
}

/**
 * Whether two mirrors hold the same rules: the same folder defaults and the
 * same exceptions, whatever order they were read in, and the same validity.
 *
 * Order-insensitive because a file's rule order is the customer's to change,
 * and a reordered file is not a different policy. The etag is not compared:
 * it names a version of the file, and two versions can say the same thing.
 */
export function sameRules(a: PrivacyMirror, b: PrivacyMirror): boolean {
  if (a.invalid !== b.invalid) return false;
  return (
    sameSet(
      a.folders.map((folder) => JSON.stringify([folder.prefix, folder.visibility])),
      b.folders.map((folder) => JSON.stringify([folder.prefix, folder.visibility])),
    ) &&
    sameSet(
      a.notes.map((note) => JSON.stringify([note.path, note.visibility])),
      b.notes.map((note) => JSON.stringify([note.path, note.visibility])),
    )
  );
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((value, index) => value === y[index]);
}

/**
 * Writing the starting layout, if and only if the bucket has none.
 *
 * Split out of `lib/scaffold.ts` — see that file's header for the scaffolder's
 * overall rules.
 */

import { hasExistingContext, hasForeignContent } from "./detect";
import { renderPrivacyManifest } from "./privacyManifest";
import { renderCustomFolderReadme, renderFolderReadme, renderIndex } from "./readmes";
import {
  INDEX_KEY,
  PARA_FOLDERS,
  PRIVACY_KEY,
  type ContextKind,
  type CustomFolder,
  type ScaffoldStore,
  type StructureTemplate,
} from "./store";

/**
 * Every file a fresh context starts with, **in write order, essentials first**.
 *
 * A folder in object storage is not a thing you create — it is the prefix of a
 * key that exists. `README.md` is what makes each one real, and it carries the
 * folder's purpose while it is at it.
 *
 * The order is not cosmetic. A bucket can stop accepting writes partway
 * through — a credential rotated out from under us, a policy change, a bucket
 * that filled up — and what has landed by then is decided entirely by this
 * list. `privacy.md` goes first because it is the one file whose absence makes
 * the context behave differently rather than merely read thinner; see
 * `ESSENTIAL_KEYS`.
 */
export function scaffoldFiles(
  template: StructureTemplate,
  customFolders: readonly CustomFolder[] = [],
  kind: ContextKind = "personal",
): { key: string; body: string }[] {
  const files = [
    { key: PRIVACY_KEY, body: renderPrivacyManifest(template, customFolders, kind) },
    { key: INDEX_KEY, body: renderIndex(template, customFolders, kind) },
  ];
  if (template === "para") {
    for (const folder of PARA_FOLDERS) {
      files.push({ key: `${folder}/README.md`, body: renderFolderReadme(folder) });
    }
  } else {
    for (const entry of customFolders) {
      files.push({
        key: `${entry.folder}/README.md`,
        body: renderCustomFolderReadme(entry),
      });
    }
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/*                                 scaffolding                                */
/* -------------------------------------------------------------------------- */

/**
 * THE FILES A CONTEXT CANNOT FUNCTION SAFELY WITHOUT.
 *
 * `privacy.md`, and nothing else. That is read off the gateway's own code
 * (`apps/mcp/src/index.js`), not chosen as a preference:
 *
 *  - **`privacy.md` is load-bearing, and it is a security control.** It is the
 *    visibility manifest `loadPrivacyState` parses, and its absence is not a
 *    thinner version of the same thing — `loadPrivacyState` falls through to
 *    `loadLegacyPrivacyState`, so the context silently runs on the
 *    pre-manifest `.note-acl/*.json` format. `set_folder_visibility` refuses
 *    outright ("privacy.md is required before folder visibility can be
 *    changed"), and `persistExactVisibility` writes any per-note decision into
 *    the legacy sidecar instead of the manifest. Reads do fail closed —
 *    `visibilityOf` with no rules returns `private` — so nothing leaks, but a
 *    context whose access control is a fallback nobody chose is not one we
 *    should call created.
 *  - **`index.md` is not.** The gateway reads it in exactly one place, and
 *    guarded: `toolOrient`'s `if (index && canSee("index.md", …))`. Nothing
 *    else in the gateway opens it, no visibility decision consults it, and no
 *    write path requires it. A missing `index.md` costs a paragraph of
 *    orientation prose. Best-effort.
 *  - **Folder `README.md`s are not.** A folder in object storage is the prefix
 *    of a key that exists; the READMEs are the leg-up, not the structure. An
 *    owner whose `2-areas/README.md` never landed can ask their own agent for
 *    it in one sentence — which is the point of the product.
 *
 * So a scaffold that lands `privacy.md` and loses two READMEs **succeeded**,
 * with a caveat naming what is missing. Reporting that as total failure is
 * what left people stuck.
 */
export const ESSENTIAL_KEYS: readonly string[] = [PRIVACY_KEY];

export type ScaffoldReason =
  /** Every file landed. `written` says which. */
  | "created"
  /**
   * The essentials landed; something best-effort did not. `written` says what
   * landed, `missing` says what did not, and both are true at once — this is a
   * success with a caveat, not a failure.
   */
  | "partial"
  /** The bucket already holds a context. Nothing was read or written. */
  | "existing-context"
  /** An essential file did not land. `written` says what did. */
  | "failed";

export interface ScaffoldResult {
  scaffolded: boolean;
  reason: ScaffoldReason;
  /** Keys this call created. */
  written: string[];
  /** Keys that already existed and were therefore left exactly as they were. */
  skipped: string[];
  /**
   * Keys of this layout that are **not in the bucket** now — whether the write
   * was refused or never attempted. Empty on `created`. This is what a retry
   * has left to do, and what the console tells the owner about.
   */
  missing: string[];
  /** Present when something failed. Never carries a credential. */
  error?: string;
}

/**
 * Write the starting layout, if and only if the bucket has none — or finish
 * one this control plane already began.
 *
 * Idempotent: running it twice writes nothing the second time, and running it
 * against somebody's existing workspace writes nothing at all.
 *
 * ## Best effort, except where it is not
 *
 * One failed `README.md` used to abandon the whole run and report `failed`,
 * which is both a lie and a dead end: the bucket had a working `privacy.md`
 * in it, and the person was told their context did not get set up. So the loop
 * carries on past a refused write and the *outcome* is decided by
 * `ESSENTIAL_KEYS` — `created` when everything landed, `partial` when the
 * essentials did and something optional did not, `failed` only when an
 * essential did not. A failed essential does stop the loop: there is no point
 * laying READMEs into a bucket that has just refused the access manifest, and
 * every extra `put` there is another write into storage that is misbehaving.
 */
export async function scaffoldContext(
  store: ScaffoldStore,
  options: {
    structureTemplate: StructureTemplate;
    /**
     * The owner's own root folders, for a `custom` layout. Must already have
     * been through `validateCustomFolders` — these become bucket keys, and this
     * function does not re-check them.
     */
    customFolders?: readonly CustomFolder[];
    /**
     * Finish a layout **we** already started, rather than refusing because it
     * is there.
     *
     * Set only by a caller holding control-plane evidence that this bucket was
     * observed empty and then written into by us — `storageBindings`'
     * `scaffoldMissing`. It swaps the first guard from "is anything here" to
     * "is anything here that we did not write", which is `hasForeignContent`;
     * read its comment for why that is still safe for somebody's live vault.
     * The per-key `get` below is unchanged either way, so nothing this flag
     * does can overwrite a byte.
     */
    resume?: boolean;
    /**
     * Personal or shared. Decides what `privacy.md` says the
     * folders default to, and nothing else — see `startingVisibility`.
     *
     * Defaults to `personal`, which is the conservative branch: a caller that
     * forgets it scaffolds an all-private context, which is thin rather than
     * disclosing. The control plane always passes it; see `StructureChoice`.
     */
    kind?: ContextKind;
  },
): Promise<ScaffoldResult> {
  const files = scaffoldFiles(
    options.structureTemplate,
    options.customFolders ?? [],
    options.kind ?? "personal",
  );

  const occupied =
    options.resume === true
      ? await hasForeignContent(store, files)
      : await hasExistingContext(store);
  if (occupied) {
    return {
      scaffolded: false,
      reason: "existing-context",
      written: [],
      skipped: [],
      missing: [],
    };
  }

  const essential = new Set(ESSENTIAL_KEYS);
  const written: string[] = [];
  const skipped: string[] = [];
  let error: string | undefined;
  for (const file of files) {
    try {
      // The second guard. The detector above looked at the shape of the
      // bucket; this looks at the exact key about to be written.
      if ((await store.get(file.key)) !== null) {
        skipped.push(file.key);
        continue;
      }
      const put = await store.put(file.key, file.body);
      if (put === null) {
        skipped.push(file.key);
        continue;
      }
      written.push(file.key);
    } catch (caught) {
      // First failure wins the message: it is the one that describes what went
      // wrong with the bucket, and the five that follow it are echoes.
      error ??= scaffoldErrorMessage(caught);
      if (essential.has(file.key)) break;
    }
  }

  const landed = new Set([...written, ...skipped]);
  const missing = files
    .map((file) => file.key)
    .filter((key) => !landed.has(key));
  const reason: ScaffoldReason = !ESSENTIAL_KEYS.every((key) => landed.has(key))
    ? "failed"
    : missing.length > 0
      ? "partial"
      : "created";

  return {
    scaffolded: written.length > 0,
    reason,
    written,
    skipped,
    missing,
    error,
  };
}

function scaffoldErrorMessage(error: unknown): string {
  const message = String(
    (error as { message?: unknown })?.message ?? error ?? "unknown error",
  );
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

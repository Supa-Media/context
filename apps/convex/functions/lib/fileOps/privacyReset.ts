/**
 * Repairing a `privacy.md` that no longer parses.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import {
  PRIVACY_KEY,
  type Visibility,
  isPlumbing,
  overrideFor,
  parsePrivacyManifest,
  renderPrivacyRulesBlock,
} from "../privacy";
import { type Clearance } from "../clearance";
import { renderPrivacyManifestForFolders } from "../scaffold";
import { LIST_PAGE_CAP, RECOVER_PREFIX, type FileStore } from "./store";
import { FileOpError } from "./errors";
import { timestampSlug } from "./paths";
import { loadPrivacyState } from "./privacyState";

/* -------------------------------------------------------------------------- */
/*                        repairing a broken privacy.md                       */
/* -------------------------------------------------------------------------- */

export interface PrivacyResetResult {
  path: string;
  /** The top-level folders the new manifest declares, all `private`. */
  folders: string[];
  /**
   * Where the unreadable file was kept, or `null` when there was nothing to
   * keep. A person whose manifest merely had a typo has not lost the other
   * forty lines; they are one `.history/` key away.
   */
  backedUpTo: string | null;
  /**
   * True when `folders` is not all of them — the walk hit the page cap, or a
   * folder was dropped because its name cannot be a manifest rule.
   *
   * One flag for both because the person's next move is the same either way:
   * anything missing has no line, so it inherits `default_visibility: private`
   * and can be given one by hand. The console says the list is short rather
   * than printing a count that reads like the whole bucket — the same rule
   * `noteCountTruncated` follows.
   */
  partial: boolean;
}

/**
 * Write a working `privacy.md` over a missing or unreadable one.
 *
 * ## Why this exists
 *
 * A bucket whose manifest does not parse fails closed: `loadPrivacyState`
 * returns no rules, every note reads as private, and `mutateManifest` refuses
 * every write — so `setVisibility` and `setFolderVisibility`, the only two ways
 * in, both answer `PRIVACY_MANIFEST_MISSING` or `PRIVACY_MANIFEST_INVALID`. The
 * console said "write a valid privacy.md at the root of the bucket, or ask a
 * connected AI client to", and **neither was possible**: `assertWritablePath`
 * refuses `privacy.md` here, and the gateway's `isPlumbing` refuses it in
 * `write_note` and answers `set_folder_visibility` with "privacy.md is required
 * before folder visibility can be changed". The only exit was rclone or the
 * provider's own web console. This is the exit.
 *
 * ## The four things that keep it from being a hole
 *
 *  1. **It only runs on a manifest that is already broken.** A parseable file
 *     is refused with `PRIVACY_MANIFEST_USABLE`, so this can never be the way
 *     somebody's curated access map gets flattened. That check is the whole
 *     safety argument, and it is the state the console's own banner reports —
 *     `manifestUsable === false` on the root listing is exactly
 *     `text === null || invalid`.
 *  2. **Every folder is written `private`.** The bucket was already failing
 *     closed, so an all-private manifest is the one rewrite under which no note
 *     changes hands.
 *
 *     This used to read "which is why `renderPrivacyManifestForFolders` takes
 *     no visibility argument", and that stopped being true when a shared
 *     context's scaffold learned to start its folders `team`: the function now
 *     takes a `ContextKind`, which is a visibility argument wearing a different
 *     noun. **The guarantee moved from the signature to this call site**, which
 *     passes no kind and so gets the `personal` default. Two tests fail the
 *     moment it passes `"shared"`, and `scaffold.ts` says beside the parameter
 *     that a call site adding one here is the bug — but nothing in the type
 *     stops it any more, so the reader of this paragraph is the guard.
 *  3. **Owner clearance only.** `scope` is `private` for an owner and `team`
 *     for everybody else (`scopeForRole`), and rewriting a context's whole
 *     access map is not an editor's to do — it is the same boundary that keeps
 *     an editor from seeing the private notes the map governs. Checked here as
 *     well as at the action, because this module is the one that is testable
 *     without a session.
 *  4. **The unreadable file is kept.** A manifest that fails to parse usually
 *     fails on one line; the other rules in it are the owner's work and may be
 *     the only record of what was shared with whom. It goes to `.history/`
 *     under the same convention `writeFile` uses, so it is recoverable by the
 *     same route as any other overwritten note.
 *
 * ## Why it declares the bucket's real folders
 *
 * The scaffold writes the five PARA names because it is laying down a bucket
 * that has nothing in it. This runs against a bucket that has a life already —
 * frequently the case this whole feature is for, since a workspace synced from
 * Obsidian is exactly the kind that arrives with a hand-edited manifest — so
 * declaring `0-inbox … 4-archive` over somebody's `Journal/` and `Clients/`
 * would hand them a file with no line to edit for any folder they have. The
 * root walk is delimited and bounded like every other listing here; a bucket
 * too wide to finish gets the folders we saw and says the list is short, which
 * costs a line to add by hand and never costs visibility.
 */
export async function resetPrivacyManifest(
  store: FileStore,
  options: { clearance: Clearance; now: number },
): Promise<PrivacyResetResult> {
  if (options.clearance.scope !== "private") {
    // Same wording an editor gets for anything else out of reach, and the
    // action above refuses first. Belt and braces: this module is the one an
    // in-memory test can drive, so the rule is asserted where it can be.
    throw new FileOpError(
      "PRIVACY_MANIFEST_READ_ONLY",
      "Only the owner of a context can rewrite its access map.",
    );
  }

  const state = await loadPrivacyState(store);
  if (state.text !== null && !state.invalid) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_USABLE",
      "privacy.md is readable, so there is nothing to reset. Change a folder or note's visibility instead.",
    );
  }

  const { folders, partial } = await rootFolders(store);
  const text = renderPrivacyManifestForFolders(folders);
  // The repair's whole job is to leave a file the parser accepts. Every folder
  // was checked individually above, so this cannot fire — which is exactly why
  // it is cheap to keep: if it ever does, the bucket is left broken as it was
  // rather than broken in a new way with the one exit spent.
  parsePrivacyManifest(text);

  let backedUpTo: string | null = null;
  if (state.text !== null) {
    // The copy keeps the name of the file it came from, and `.context/` is
    // plumbing that no listing shows either way.
    backedUpTo = `${RECOVER_PREFIX}${PRIVACY_KEY}.${timestampSlug(options.now)}.md`;
    await store.put(backedUpTo, state.text);
  }

  const conditional =
    store.capabilities?.conditionalWrite === true && state.etag !== null;
  const put = conditional
    ? await store.put(PRIVACY_KEY, text, { onlyIf: { etagMatches: state.etag! } })
    : state.text === null && store.capabilities?.conditionalCreate === true
      ? await store.put(PRIVACY_KEY, text, { onlyIf: { absent: true } })
      : await store.put(PRIVACY_KEY, text);
  if (put === null) {
    // Somebody repaired it — or fixed it by hand in Obsidian — between our read
    // and our write. Theirs stands; re-reading is the console's next move
    // anyway, and it will find a usable manifest.
    throw new FileOpError(
      "CONFLICT",
      "privacy.md changed while it was being repaired. Reload to see what it says now.",
    );
  }

  return { path: PRIVACY_KEY, folders, backedUpTo, partial };
}

/**
 * The bucket's top-level folders, as far as they can be written down.
 *
 * Delimited, so this is the folder names and not every key under them — the
 * same reason `countNotes` is delimited at the root, and the same trap avoided:
 * a flat listing returns `.history/…` first and would spend the whole page
 * budget inside it.
 *
 * A bucket whose notes all sit at the root has no folders and gets a manifest
 * with none, which parses and is correct: `default_visibility: private` covers
 * everything, and the person can add a line when they make a folder.
 */
async function rootFolders(
  store: FileStore,
): Promise<{ folders: string[]; partial: boolean }> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let partial = false;

  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: "", delimiter: "/", cursor, limit: 1000 });
    for (const raw of listing.delimitedPrefixes ?? []) {
      const folder = raw.replace(/\/+$/, "");
      if (!folder) continue;
      // `.history/`, `.audit/`, `.obsidian/`.
      if (isPlumbing(folder)) continue;
      if (!writableAsRule(folder)) {
        partial = true;
        continue;
      }
      seen.add(folder);
    }
    if (!listing.truncated) break;
    if (!listing.cursor) {
      partial = true;
      break;
    }
    cursor = listing.cursor;
    if (page === LIST_PAGE_CAP - 1) partial = true;
  }

  return { folders: [...seen].sort(), partial };
}

/**
 * Can this folder name be a line in `folder_defaults`?
 *
 * **A bucket key is far more permissive than a manifest rule, and nothing
 * guarantees a key came through our own path validation.** Obsidian's sync
 * plugin, rclone and the provider's web console all write keys directly, so
 * this function's input is arbitrary bytes that S3 accepted. Two ways that goes
 * wrong, and they fail in opposite directions:
 *
 *  - **A colon.** `parsePrivacyManifest`'s rule pattern is
 *    `^([^:]+?)\/?\s*:\s*(team|private)$`, so a folder called `2026: notes`
 *    produces a line the parser rejects — and one such folder would make the
 *    repair write a manifest that does not parse. The person's one exit from a
 *    broken manifest would leave it broken, with no second thing to try. (A `#`
 *    is the quieter version: the parser strips it as a comment, so the rule
 *    silently names a different folder.)
 *  - **A newline.** A legal S3 key character, and a name carrying one appends
 *    whatever it likes to `folder_defaults`. The useful thing to append is
 *    `: team`. That is a privilege escalation written into a folder name, and
 *    the manifest is the one file in the product where that lands.
 *
 * So the check is not a character blacklist — a blacklist is a guess about a
 * parser, and this one has a comment stripper, a trailing-slash tolerance and a
 * dot-segment rule. It **renders one rule and parses it back with the real
 * parser**, and accepts the folder only if exactly one rule comes out naming
 * exactly it. The oracle is the code that will read the file, so the two cannot
 * drift, and a future change to either is checked by construction.
 *
 * A folder that fails is left out of the manifest rather than blocking the
 * repair. It then has no rule, so it inherits `default_visibility: private` —
 * the fail-closed direction — and `partial` says the list is short.
 */
export function writableAsRule(folder: string, vis: Visibility = "private"): boolean {
  try {
    const parsed = parsePrivacyManifest(
      renderPrivacyRulesBlock([{ prefix: folder, vis }], new Map()),
    );
    return (
      parsed.rules.length === 1 &&
      parsed.rules[0]!.prefix === folder &&
      parsed.rules[0]!.vis === vis &&
      parsed.overrides.size === 0
    );
  } catch {
    return false;
  }
}

/**
 * The same round trip for a NOTE OVERRIDE, which is the other half of the
 * format and the other half a caller supplies.
 *
 * `writableAsRule` existed and was correct, and guarded exactly one path —
 * `rootFolders`, the manifest *repair* routine. Neither visibility setter
 * reached it, and those are the two functions that take a caller-supplied path
 * and interpolate it into the file. A guard that cannot be reached from the
 * door the attacker uses is not a guard for that door.
 *
 * Why this is not redundant with `normalizePath`'s control-character refusal:
 * a blacklist is a guess about a parser that has a comment stripper, a
 * trailing-slash tolerance and a dot-segment rule. `2-areas/pay: team`
 * contains no control character at all, and renders a rule the parser reads as
 * naming `2-areas/pay` — a different note, silently. The oracle here is the
 * code that will actually read the file, so the two cannot drift.
 */
export function writableAsOverride(path: string, vis: Visibility): boolean {
  try {
    const parsed = parsePrivacyManifest(
      renderPrivacyRulesBlock([], new Map([[path, vis]])),
    );
    if (parsed.rules.length !== 0 || parsed.overrides.size !== 1) return false;
    // Through `overrideFor`, like every other override read in this file: the
    // map has one entry so the case fold cannot change the answer, which is
    // exactly why reaching past the helper would be a harmless-looking
    // exception.
    return overrideFor(parsed.overrides, path) === vis;
  } catch {
    return false;
  }
}

/** What a path that cannot be written as a rule is told, at either setter. */
export const UNWRITABLE_PATH_MESSAGE =
  "That path cannot be recorded in privacy.md: it contains a character the rule " +
  "format uses. Rename it and try again.";

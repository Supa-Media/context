/**
 * Changing a note's or a folder's visibility.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import {
  type Visibility,
  canSee,
  effectiveVisibility,
  isPlumbing,
  nextOverrides,
  visibilityOf,
} from "../privacy";
import { type Clearance } from "../clearance";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { folderVisibleAtScope } from "./listing";
import { assertWritablePath } from "./writing";
import { writableAsRule, writableAsOverride, UNWRITABLE_PATH_MESSAGE } from "./privacyReset";
import { mutateManifest } from "./privacyRewrite";

/* -------------------------------------------------------------------------- */
/*                                 visibility                                 */
/* -------------------------------------------------------------------------- */

export interface VisibilityResult {
  path: string;
  visibility: Visibility;
  inherited: Visibility;
  /** False when the change removed a now-redundant exception. */
  exception: boolean;
}

/**
 * Set one note's visibility, through the manifest.
 *
 * This is the only way visibility changes. Editing `visibility:` in a note's
 * frontmatter does nothing at all — frontmatter is description, the manifest
 * is access control — and that is deliberate: a note's own body must never be
 * able to widen its own audience.
 *
 * Setting a note to its folder's default **removes** the exception rather than
 * writing a redundant line, so the exception list stays a statement of what is
 * unusual. See `nextOverrides`.
 */
/**
 * Set one path's visibility without asking whose hand it is.
 *
 * `setVisibility` is a caller's verb: it refuses anybody but the owner,
 * because rewriting `privacy.md` is the owner's alone. This is the product's
 * own, used for exactly one file — `activity.md`, which Context writes and
 * must keep private whatever folder default it lands under, because it names
 * paths from every corner of the context.
 *
 * Deliberately not exported through any action or operation. A second door
 * into the manifest that skips the clearance check is only safe while its one
 * caller is a constant, so the path is a parameter for testability and there
 * is exactly one value anything passes.
 */
export async function setExactVisibility(
  store: FileStore,
  path: string,
  visibility: Visibility,
): Promise<void> {
  await mutateManifest(store, (current) => ({
    rules: current.rules,
    overrides: nextOverrides(path, visibility, current.rules, current.overrides),
  }));
}

export async function setVisibility(
  store: FileStore,
  options: { path: string; visibility: Visibility; clearance: Clearance },
): Promise<VisibilityResult> {
  // Visibility writes rewrite `privacy.md`, the file that decides what every
  // non-owner may see — so only the owner's scope may reach them. The public
  // actions already require `owner`; this refusal is the layer that survives
  // a future caller getting that minimum wrong, the way the console once did.
  if (options.clearance.scope !== "private") {
    throw new FileOpError(
      "PATH_INVALID",
      "Only the owner of a context can change visibility.",
    );
  }
  const path = requirePath(options.path);
  assertWritablePath(path);
  if (!path.endsWith(".md")) {
    throw new FileOpError(
      "PATH_INVALID",
      "Only markdown notes can have their own visibility. Set the folder's default instead.",
    );
  }
  // Belt to `normalizePath`'s brace — see `writableAsOverride`.
  //
  // Placed AFTER the specific refusals, not before them: the parser enforces
  // the `.md` rule too, so a guard in front of that check would answer "that
  // path contains a character the rule format uses" for an ordinary folder and
  // quietly take over a message another check exists to give. A check added in
  // front of another makes the second one's tests vacuous.
  if (!writableAsOverride(path, options.visibility)) {
    throw new FileOpError("PATH_INVALID", UNWRITABLE_PATH_MESSAGE);
  }

  const state = await mutateManifest(store, (current) => {
    if (!canSee(path, options.clearance.scope, current.rules, current.overrides, options.clearance.names)) throw notFound();
    const overrides = nextOverrides(path, options.visibility, current.rules, current.overrides);
    return { rules: current.rules, overrides };
  });

  const inherited = visibilityOf(path, state.rules);
  // Re-derived, never echoed back: the request is what was asked for, and the
  // manifest is what happened. With the fold, those differ — a note whose
  // case-twin is private reads private however it was set — and reporting the
  // request would be the console saying a publish happened when it did not.
  const visibility = effectiveVisibility(path, state.rules, state.overrides);
  return {
    path,
    visibility,
    inherited,
    exception: visibility !== inherited,
  };
}

/**
 * Set a folder's default.
 *
 * Every note under it that has no exception of its own follows. Notes that
 * *do* have one keep it — which is exactly why the console shows the default on
 * the folder row and a marker only on the exceptions: the picture on screen is
 * the file on disk.
 */
export async function setFolderVisibility(
  store: FileStore,
  options: { path: string; visibility: Visibility; clearance: Clearance },
): Promise<VisibilityResult> {
  // Visibility writes rewrite `privacy.md`, the file that decides what every
  // non-owner may see — so only the owner's scope may reach them. The public
  // actions already require `owner`; this refusal is the layer that survives
  // a future caller getting that minimum wrong, the way the console once did.
  if (options.clearance.scope !== "private") {
    throw new FileOpError(
      "PATH_INVALID",
      "Only the owner of a context can change visibility.",
    );
  }
  const folder = requirePath(options.path);
  if (isPlumbing(folder)) throw new FileOpError("PATH_INVALID", "That path is reserved.");
  // Belt to `normalizePath`'s brace — see `writableAsOverride`.
  if (!writableAsRule(folder, options.visibility)) {
    throw new FileOpError("PATH_INVALID", UNWRITABLE_PATH_MESSAGE);
  }

  await mutateManifest(store, (current) => {
    if (
      options.clearance.scope !== "private" &&
      !folderVisibleAtScope(folder, options.clearance, current.rules, current.overrides)
    ) {
      throw notFound();
    }
    const rules = current.rules.filter((rule) => rule.prefix !== folder);
    rules.push({ prefix: folder, vis: options.visibility });
    // A rule that merely restates the inherited default is still worth
    // keeping: `folder_defaults` is the layer people read and edit by hand,
    // and silently dropping the line they just set would look like a bug.
    return { rules, overrides: current.overrides };
  });

  return {
    path: folder,
    visibility: options.visibility,
    inherited: options.visibility,
    exception: false,
  };
}

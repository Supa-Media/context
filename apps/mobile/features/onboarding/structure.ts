/**
 * Choosing a starting shape — and knowing when not to ask.
 *
 * The step only exists for an empty bucket. The single most important thing
 * Context can do for somebody with an existing vault is **nothing**: their
 * folders come across untouched, no migration, no rewrite, and no question
 * about a structure they decided on years ago. So the flow scans first and
 * asks second, and a bucket that already holds a context skips the question
 * entirely and says what it found.
 *
 * ## Reading the scan
 *
 * The answer comes from the control plane, on the storage binding, as
 * `scaffoldReason` — the same value `scaffoldContext` already computes when a
 * bucket is verified (`functions/lib/scaffold.ts`). It is being exposed on
 * `getStorageBinding` in parallel with this screen, so it is read defensively:
 * an older deployment that does not send it yet is `undefined`.
 *
 * **`undefined` falls back to asking**, which is the safe direction. Applying a
 * structure to a bucket that turns out to have content writes nothing —
 * `hasExistingContext` refuses, and every individual write is preceded by an
 * existence check — so the worst case of asking unnecessarily is a wasted
 * question. The worst case of *not* asking when we should have is a person
 * with an empty bucket and no folders, which is the dead end this whole flow
 * exists to remove.
 */

import { PARA_FOLDERS } from "@context/convex/functions/lib/scaffold";

export type StructureTemplate = "para" | "custom";

/** What the structure step should do, given what the scan found. */
export type StructureStep =
  /** The bucket already holds a context. Report, do not prompt. */
  | { kind: "existing" }
  /** The bucket is empty (or we cannot tell). Offer a starting shape. */
  | { kind: "ask" };

export function structureStepFor(scaffoldReason: string | undefined): StructureStep {
  return scaffoldReason === "existing-context" ? { kind: "existing" } : { kind: "ask" };
}

/**
 * One line per PARA folder, for the screen.
 *
 * The folder *names* are imported so they cannot drift from what actually gets
 * written. The sentences are ours — the control plane's `FOLDER_PURPOSE`
 * blurbs are written for the README inside each folder, which is a different
 * job from a one-line label in a list. `structure.test.ts` asserts every
 * imported folder has a line here, so adding a folder upstream fails loudly
 * instead of rendering a blank row.
 */
const PARA_LINES: Record<string, string> = {
  "0-inbox": "Anything you have just captured and not filed yet.",
  "1-projects": "Work with a finish line. When it is done, it moves to the archive.",
  "2-areas": "Responsibilities that never finish — a team, your health, the finances.",
  "3-resources": "Reference you want to find again, not tied to one project.",
  "4-archive": "Finished or dormant. Nothing is deleted, it just moves out of the way.",
};

export interface ParaFolderLine {
  folder: string;
  line: string;
}

export function paraFolderLines(): ParaFolderLine[] {
  return PARA_FOLDERS.map((folder) => ({
    folder,
    line: PARA_LINES[folder] ?? "",
  }));
}

/* -------------------------------------------------------------------------- */
/*                            bring your own shape                            */
/* -------------------------------------------------------------------------- */

/** One row of the custom-structure editor. */
export interface CustomFolderRow {
  name: string;
  description: string;
}

/**
 * How many folders somebody may lay down here.
 *
 * Not a database limit — a "this is a starting point, not your filing system
 * for life" limit. Anything past a dozen top-level folders is better made in
 * the console, one at a time, once there is something to put in them.
 */
export const MAX_CUSTOM_FOLDERS = 12;

/** The editor opens with three blank rows: enough to suggest a shape. */
export function emptyCustomFolders(): CustomFolderRow[] {
  return [
    { name: "", description: "" },
    { name: "", description: "" },
    { name: "", description: "" },
  ];
}

/** Add a row. Capped, so the button stops rather than the validator scolding. */
export function addFolderRow(rows: readonly CustomFolderRow[]): CustomFolderRow[] {
  if (rows.length >= MAX_CUSTOM_FOLDERS) return [...rows];
  return [...rows, { name: "", description: "" }];
}

/**
 * Remove a row, keeping at least one on screen.
 *
 * Emptying the editor completely would leave nothing to type into and no
 * obvious way back, and "custom with no folders" is already expressible by
 * leaving the rows blank.
 */
export function removeFolderRow(
  rows: readonly CustomFolderRow[],
  index: number,
): CustomFolderRow[] {
  if (rows.length <= 1) return [{ name: "", description: "" }];
  return rows.filter((_, position) => position !== index);
}

export function setFolderRow(
  rows: readonly CustomFolderRow[],
  index: number,
  patch: Partial<CustomFolderRow>,
): CustomFolderRow[] {
  return rows.map((row, position) => (position === index ? { ...row, ...patch } : row));
}

export function canAddFolderRow(rows: readonly CustomFolderRow[]): boolean {
  return rows.length < MAX_CUSTOM_FOLDERS;
}

export type FolderErrors = Record<number, string>;

/**
 * Which rows are unusable, keyed by index.
 *
 * A blank row is not an error — it is a row somebody did not fill in, and it is
 * simply dropped. That is what makes "custom with no folders at all" a real
 * answer: you get `index.md` and `privacy.md` and a bucket you shape yourself.
 *
 * The character rule is deliberately stricter than S3 requires. These names end
 * up as folders in Obsidian, in a URL path, and in `@name/<folder>/note.md`, so
 * a slash would silently create a nested folder and a leading dot would create
 * something the gateway treats as plumbing and hides.
 */
const FOLDER_CHARS = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function validateCustomFolders(rows: readonly CustomFolderRow[]): FolderErrors {
  const errors: FolderErrors = {};
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const name = row.name.trim();
    if (name.length === 0) return; // blank rows are dropped, not rejected

    if (name.includes("/")) {
      errors[index] = "One folder per row — no slashes. You can nest folders later.";
      return;
    }
    if (name.startsWith(".")) {
      errors[index] = "A name starting with a dot is hidden from your tools. Pick another.";
      return;
    }
    if (!FOLDER_CHARS.test(name)) {
      errors[index] =
        "Letters, numbers, spaces, hyphens, dots and underscores — and it has to start with a letter or a number.";
      return;
    }
    if (name.length > 64) {
      errors[index] = "That is a long folder name. Keep it under 64 characters.";
      return;
    }

    const key = name.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      errors[index] = "You already have a folder with this name.";
      return;
    }
    seen.set(key, index);
  });

  const filled = rows.filter((row) => row.name.trim().length > 0);
  if (filled.length > MAX_CUSTOM_FOLDERS) {
    // Reported on the first row past the cap, which is the one to delete.
    let count = 0;
    rows.forEach((row, index) => {
      if (row.name.trim().length === 0) return;
      count += 1;
      if (count > MAX_CUSTOM_FOLDERS && errors[index] === undefined) {
        errors[index] = `That is more than ${MAX_CUSTOM_FOLDERS} folders. Make the rest in the console once you are in.`;
      }
    });
  }

  return errors;
}

export function hasFolderErrors(errors: FolderErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** What the control plane is asked to create. Blank rows are gone by here. */
export interface StructureFolderSpec {
  folder: string;
  description: string;
}

export function toFolderSpecs(rows: readonly CustomFolderRow[]): StructureFolderSpec[] {
  return rows
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({
      folder: row.name.trim(),
      description: row.description.trim(),
    }));
}

/** The arguments for the callable that lays the structure down. */
export interface ApplyStructureArgs {
  workspaceId: string;
  structureTemplate: StructureTemplate;
  /** Only sent for `custom`; omitted entirely for `para`. */
  folders?: StructureFolderSpec[];
}

/**
 * Build the call.
 *
 * `folders` is **omitted** for PARA rather than sent empty, for the same reason
 * `toBindStorageArgs` omits `forcePathStyle`: an empty array is an answer
 * ("create no folders"), and PARA is not that answer. It is also omitted for a
 * custom choice with nothing filled in, which *is* that answer — so the two
 * cases are told apart by the template, not by the array.
 */
export function toApplyStructureArgs(
  workspaceId: string,
  template: StructureTemplate,
  rows: readonly CustomFolderRow[],
): ApplyStructureArgs {
  if (template === "para") return { workspaceId, structureTemplate: "para" };
  return {
    workspaceId,
    structureTemplate: "custom",
    folders: toFolderSpecs(rows),
  };
}

/** A plain summary of what pressing the button will write. Not a confirmation. */
export function describeOutcome(
  template: StructureTemplate,
  rows: readonly CustomFolderRow[],
): string {
  if (template === "para") {
    return `${PARA_FOLDERS.length} folders, each with a README saying what it holds, plus index.md and privacy.md.`;
  }
  const count = toFolderSpecs(rows).length;
  if (count === 0) {
    return "Just index.md and privacy.md. The shape is yours to make.";
  }
  return `${count} folder${count === 1 ? "" : "s"}, plus index.md and privacy.md.`;
}

/**
 * The line that takes the weight out of the choice.
 *
 * This is the whole reason the step is allowed to be this short. Nothing here
 * is a schema and nothing is one-way: the folders are folders, in a bucket the
 * person owns, and the console renames and moves them — as does any AI client
 * they connect, which is the part people do not expect and is worth saying out
 * loud.
 */
export const REVERSIBLE_NOTE =
  "You can rename, add, or reorganise any of this later — in the console, or just by asking a connected AI client to do it.";

/**
 * Why the descriptions are worth typing.
 *
 * They are not decoration: each one becomes that folder's README and its line
 * in the manifest, which is what a connected AI client reads to work out where
 * something belongs. One clause, said once, next to the fields.
 */
export const DESCRIPTION_PURPOSE =
  "Each description becomes that folder's README and its line in the manifest, so a connected AI client knows where things belong.";

/**
 * The privacy default, stated rather than offered.
 *
 * Every folder starts `private`, and onboarding does not put a per-folder
 * control on screen. `team` means named people the owner has granted access to,
 * and a brand-new personal context has granted nobody anything — so a `team`
 * default would grant nothing today and then, the first time somebody is
 * invited, quietly open a folder that nobody decided to open. A default whose
 * consequence arrives later and silently is the wrong default. Changing one is
 * one obvious control in the console.
 */
export const PRIVACY_DEFAULT_NOTE =
  "Everything starts private — visible to you and to nothing else — until you share a folder yourself.";

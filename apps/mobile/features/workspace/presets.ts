/**
 * The layouts a new **workspace** starts from.
 *
 * ## Why a workspace needs its own presets at all
 *
 * PARA is a personal-productivity taxonomy. `1-projects` / `2-areas` /
 * `3-resources` sorts *one person's* work by how permanent it is, and it is a
 * good default for a brain for exactly that reason. A company's context is
 * sorted by something else — who owns a thing, and which outside party it is
 * about — and a team handed five folders named after somebody else's
 * productivity system files nothing into them.
 *
 * So the workspace flow offers three starting points and the standard layout
 * is not the default one. Every one of them is **a suggestion, not a schema**:
 * the gateway addresses whatever paths exist, and a folder here can be renamed,
 * nested, added to, or deleted in the console or in Obsidian five minutes
 * later. Nothing below this reads the choice again.
 *
 * ## The descriptions are load-bearing, not blurb
 *
 * Each becomes that folder's `README.md` and its line in `index.md`, verbatim —
 * which means it is also the thing a connected AI client reads when it is
 * deciding where to file a note. A vague description ("stuff about the team")
 * produces a folder that fills with everything. So each one below says what
 * belongs in the folder *and* what does not, in the same register the PARA
 * descriptions use.
 *
 * They are written in the third person ("the team's", never "your") because a
 * workspace has no single reader, and `index.md` in a shared bucket addressed
 * to "you" reads as somebody else's file to everyone but its author.
 */

import type { CustomFolderRow } from "../onboarding/structure";

export type WorkspacePresetKey = "company" | "client" | "para" | "custom";

export interface WorkspacePreset {
  key: WorkspacePresetKey;
  label: string;
  /** One line under the label in the picker. */
  summary: string;
  /**
   * The folders it lays down, or `null` for the two that do not name their own:
   * `para` (the control plane owns that list) and `custom` (the person does).
   */
  folders: readonly { folder: string; description: string }[] | null;
}

/**
 * The default. A company's own context: how it works, what it is building, and
 * who it is building it for.
 *
 * `0-inbox` is kept from PARA deliberately — it is the one folder whose job is
 * the same for a person and for a team, it is where an AI client drops a
 * capture it has not been told how to file, and its absence is what makes
 * agents guess.
 */
const COMPANY_FOLDERS = [
  {
    folder: "0-inbox",
    description:
      "Unfiled captures. Anything that arrives before somebody has decided where it belongs — meeting notes, forwarded threads, half-formed ideas. Empty it by moving notes out, not by deleting them.",
  },
  {
    folder: "1-projects",
    description:
      "Active work with an end state, one folder per project. Something that will not finish belongs in 2-teams instead.",
  },
  {
    folder: "2-teams",
    description:
      "Ongoing responsibilities, one folder per team or function. What a team owns, how it runs, and the standing context somebody joining it would need.",
  },
  {
    folder: "3-handbook",
    description:
      "How this company works: decisions and why they were made, policies, processes, and onboarding. The answer to a question that has been asked twice belongs here.",
  },
  {
    folder: "4-customers",
    description:
      "One folder per customer or account: what they need, what has been promised, and what has actually happened.",
  },
  {
    folder: "5-archive",
    description:
      "Finished, cancelled, or superseded. Move things here rather than deleting them — an archived project is the record of a decision.",
  },
] as const;

/**
 * For an agency, a studio, or a consultancy — an organisation whose work is
 * sorted by *who it is for* before anything else.
 *
 * The distinction from `company` is not cosmetic. In a client business the same
 * project name recurs across three clients, so a flat `1-projects` collides on
 * day one and everything ends up prefixed by hand.
 */
const CLIENT_FOLDERS = [
  {
    folder: "0-inbox",
    description:
      "Unfiled captures. Anything that arrives before somebody has decided which client or which project it belongs to.",
  },
  {
    folder: "1-clients",
    description:
      "One folder per client, with their engagements nested inside. Everything about the work for one client lives under their folder.",
  },
  {
    folder: "2-pipeline",
    description:
      "Prospects, proposals, and pitches that are not signed work yet. A win moves into 1-clients; a loss moves into 4-archive with the reason.",
  },
  {
    folder: "3-practice",
    description:
      "How this studio works: templates, process, rate cards, contract language, and the lessons worth carrying to the next engagement.",
  },
  {
    folder: "4-archive",
    description:
      "Finished engagements and closed pipeline. Move things here rather than deleting them.",
  },
] as const;

export const WORKSPACE_PRESETS: readonly WorkspacePreset[] = [
  {
    key: "company",
    label: "Company",
    summary: "Projects, teams, a handbook, and customers. The default for an internal workspace.",
    folders: COMPANY_FOLDERS,
  },
  {
    key: "client",
    label: "Client work",
    summary: "Sorted by client first: engagements, pipeline, and how the studio works.",
    folders: CLIENT_FOLDERS,
  },
  {
    key: "para",
    label: "Standard (PARA)",
    summary: "The same five folders a personal brain starts with. Familiar if the team already uses it.",
    folders: null,
  },
  {
    key: "custom",
    label: "Name your own",
    summary: "Up to twelve root folders, each with a line saying what belongs in it.",
    folders: null,
  },
];

/** The preset a workspace starts on if nobody chooses. */
export const DEFAULT_PRESET: WorkspacePresetKey = "company";

export function presetFor(key: WorkspacePresetKey): WorkspacePreset {
  const found = WORKSPACE_PRESETS.find((preset) => preset.key === key);
  // Not reachable through the picker, which renders this same list. A thrown
  // error beats a silent fall back to `company`, which would lay somebody
  // else's folders into a bucket.
  if (found === undefined) throw new Error(`unknown workspace preset: ${key}`);
  return found;
}

/**
 * A preset's folders as editable rows.
 *
 * The picker is not a commitment: choosing "Company" and then opening the rows
 * to rename `4-customers` is the common case, and it is the reason a preset is
 * modelled as a starting *value* for the custom editor rather than as a mode
 * the editor is locked out of. `applyStructure` receives `custom` and the rows
 * either way, so nothing downstream has to know which button was pressed.
 *
 * `para` and `custom` return an empty list: PARA's folders belong to the
 * control plane and are not editable here, and `custom` starts blank.
 */
export function presetRows(key: WorkspacePresetKey): CustomFolderRow[] {
  const preset = presetFor(key);
  if (preset.folders === null) return [];
  return preset.folders.map((entry) => ({
    name: entry.folder,
    description: entry.description,
  }));
}

/**
 * Which `structureTemplate` a preset resolves to.
 *
 * Only `para` is `para`. Everything else — including the two presets we wrote
 * ourselves — goes down the `custom` path, because that is the path that
 * carries folder names and descriptions. The control plane has one list of
 * PARA folders and it is not this file's business to restate it.
 */
export function templateFor(key: WorkspacePresetKey): "para" | "custom" {
  return key === "para" ? "para" : "custom";
}

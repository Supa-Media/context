/**
 * The kinds of workspace somebody can make, and the folders each starts with.
 *
 * ## Why a workspace needs its own presets at all
 *
 * PARA is a personal-productivity taxonomy. `1-projects` / `2-areas` /
 * `3-resources` sorts *one person's* work by how permanent it is, and it is a
 * good default for a workspace for exactly that reason. A company's context is
 * sorted by something else — who owns a thing, and which outside party it is
 * about — and a team handed five folders named after somebody else's
 * productivity system files nothing into them.
 *
 * So the workspace flow asks what kind of workspace this is — a business, an
 * agency, a shared project — and lays down folders for that answer; the
 * standard layout is offered, and it is not the default one. Every one of them is **a suggestion, not a schema**:
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

export type WorkspacePresetKey = "business" | "agency" | "project" | "para" | "custom";

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
 * The default. A business's own context: what it is working on, the teams that
 * run it, the clients it works for, and how it works.
 *
 * `0-inbox` is kept from PARA deliberately — it is the one folder whose job is
 * the same for a person and for a team, it is where an AI client drops a
 * capture it has not been told how to file, and its absence is what makes
 * agents guess.
 *
 * `2-teams` and `3-clients` are the two folders a business reaches for first
 * and PARA has no word for (the owner asked for exactly these, 2026-09-26).
 */
const BUSINESS_FOLDERS = [
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
    folder: "3-clients",
    description:
      "One folder per client or customer: who they are, what they need, what has been promised, and what has actually happened.",
  },
  {
    folder: "4-handbook",
    description:
      "How this business works: decisions and why they were made, policies, processes, and onboarding. The answer to a question that has been asked twice belongs here.",
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
 * The distinction from `business` is not cosmetic. In a client business the
 * same project name recurs across three clients, so a flat `1-projects`
 * collides on day one and everything ends up prefixed by hand.
 */
const AGENCY_FOLDERS = [
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
      "Prospects, proposals, and pitches that are not signed work yet. A win moves into 1-clients; a loss moves into 5-archive with the reason.",
  },
  {
    folder: "3-team",
    description:
      "The people doing the work: who does what, availability, and how the studio is organised.",
  },
  {
    folder: "4-practice",
    description:
      "How this studio works: templates, process, rate cards, contract language, and the lessons worth carrying to the next engagement.",
  },
  {
    folder: "5-archive",
    description:
      "Finished engagements and closed pipeline. Move things here rather than deleting them.",
  },
] as const;

/**
 * One shared piece of work with a finish line — a launch, an event, a book, a
 * renovation. Sorted by stage of the work rather than by who owns it, because
 * everybody in it owns the same thing.
 */
const PROJECT_FOLDERS = [
  {
    folder: "0-inbox",
    description:
      "Unfiled captures. Anything that arrives before somebody has decided where in the project it belongs.",
  },
  {
    folder: "1-plan",
    description:
      "The goal, the scope, the timeline, and the decisions that shaped them. Somebody joining late reads this folder first.",
  },
  {
    folder: "2-work",
    description:
      "The work itself: drafts, specs, designs, and task lists. One note or folder per piece of work.",
  },
  {
    folder: "3-meetings",
    description:
      "Notes from meetings and calls, one per meeting, dated. Decisions made in one move into 1-plan.",
  },
  {
    folder: "4-reference",
    description:
      "Material the project draws on but did not produce: research, contacts, links, and source documents.",
  },
  {
    folder: "5-archive",
    description:
      "Superseded drafts and dropped ideas. Move things here rather than deleting them.",
  },
] as const;

export const WORKSPACE_PRESETS: readonly WorkspacePreset[] = [
  {
    key: "business",
    label: "Business",
    summary: "Projects, teams, clients, and a handbook. The default for a company.",
    folders: BUSINESS_FOLDERS,
  },
  {
    key: "agency",
    label: "Agency or studio",
    summary: "Sorted by client first: engagements, pipeline, the team, and how the studio works.",
    folders: AGENCY_FOLDERS,
  },
  {
    key: "project",
    label: "A shared project",
    summary: "One piece of work with a finish line: the plan, the work, meetings, and reference.",
    folders: PROJECT_FOLDERS,
  },
  {
    key: "para",
    label: "Standard (PARA)",
    summary: "The same five folders a personal workspace starts with. Familiar if the team already uses it.",
    folders: null,
  },
  {
    key: "custom",
    label: "Something else",
    summary: "Name up to twelve root folders yourself, each with a line saying what belongs in it.",
    folders: null,
  },
];

/** The preset a workspace starts on if nobody chooses. */
export const DEFAULT_PRESET: WorkspacePresetKey = "business";

export function presetFor(key: WorkspacePresetKey): WorkspacePreset {
  const found = WORKSPACE_PRESETS.find((preset) => preset.key === key);
  // Not reachable through the picker, which renders this same list. A thrown
  // error beats a silent fall back to `business`, which would lay somebody
  // else's folders into a bucket.
  if (found === undefined) throw new Error(`unknown workspace preset: ${key}`);
  return found;
}

/**
 * A preset's folders as editable rows.
 *
 * The picker is not a commitment: choosing "Business" and then opening the rows
 * to rename `3-clients` is the common case, and it is the reason a preset is
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

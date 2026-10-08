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

/**
 * The kinds of workspace somebody can make, and the folders each starts with.
 *
 * ## Every kind starts with the same five folders
 *
 * The five built-in folders (`packages/shared/src/folderRoles.cjs`) are the
 * same in every workspace: Inbox, Projects, Areas, Resources and Archive, named
 * `0-inbox`, `1-projects`, `2-areas`, `3-resources` and `9-archive`. The gateway,
 * the organizer and `archive_note` rely on them, so the kind a person picks
 * never removes one.
 *
 * The kind chooses only the **extras**: `business` adds clients and teams,
 * `product` adds teams and products, and `project` adds nothing. That is
 * decided by the owner (2026-10-08). The older per-kind layouts (a handbook,
 * a pipeline, a set of client-named folders) are gone; a workspace made with
 * one still has its folders, and nothing here reads them again.
 *
 * PARA is the same five folders. It stays as its own choice because a person
 * who already uses it expects the control plane's list, and its folders are
 * not editable here.
 *
 * Every folder here is **a suggestion, not a schema**: the gateway addresses
 * whatever paths exist, and a folder can be renamed, nested, added to, or
 * deleted in the console or in Obsidian five minutes later. Nothing below this
 * reads the choice again.
 *
 * ## The descriptions are load-bearing, not blurb
 *
 * Each becomes that folder's `README.md` and its line in `index.md`, verbatim —
 * which means it is also the thing a connected AI client reads when it is
 * deciding where to file a note. The descriptions come from `ROLE_DESCRIPTION`
 * so the five main folders say the same thing in every app.
 *
 * They are written in the third person ("the team's", never "your") because a
 * workspace has no single reader, and `index.md` in a shared bucket addressed
 * to "you" reads as somebody else's file to everyone but its author.
 */

import { ROLE_DESCRIPTION } from "@context/shared/src/folderRoles.cjs";
import type { CustomFolderRow } from "../onboarding/structure";

export type WorkspacePresetKey = "business" | "product" | "project" | "para" | "custom";

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

// The five built-in folders, in drawing order. Literal names, so the guard in
// `teamShare` can read them out of this file as text.
const INBOX = { folder: "0-inbox", description: ROLE_DESCRIPTION.inbox };
const PROJECTS = { folder: "1-projects", description: ROLE_DESCRIPTION.projects };
const AREAS = { folder: "2-areas", description: ROLE_DESCRIPTION.areas };
const RESOURCES = { folder: "3-resources", description: ROLE_DESCRIPTION.resources };
const ARCHIVE = { folder: "9-archive", description: ROLE_DESCRIPTION.archive };

// The extras, at their fixed numbers.
const CLIENTS = { folder: "4-clients", description: ROLE_DESCRIPTION.clients };
const TEAMS = { folder: "5-teams", description: ROLE_DESCRIPTION.teams };
const PRODUCTS = { folder: "6-products", description: ROLE_DESCRIPTION.products };

/** A company: the people it works for, and the teams that run it. */
const BUSINESS_FOLDERS = [INBOX, PROJECTS, AREAS, RESOURCES, CLIENTS, TEAMS, ARCHIVE] as const;

/** A company that sells or makes things: what it makes, and who builds it. */
const PRODUCT_FOLDERS = [INBOX, PROJECTS, AREAS, RESOURCES, TEAMS, PRODUCTS, ARCHIVE] as const;

/** One shared piece of work with a finish line: the five and nothing more. */
const PROJECT_FOLDERS = [INBOX, PROJECTS, AREAS, RESOURCES, ARCHIVE] as const;

export const WORKSPACE_PRESETS: readonly WorkspacePreset[] = [
  {
    key: "business",
    label: "Business",
    summary: "The five standard folders, plus clients and teams. The default for a company.",
    folders: BUSINESS_FOLDERS,
  },
  {
    key: "product",
    label: "Product company",
    summary: "The five standard folders, plus teams and products: what is made or sold, and who makes it.",
    folders: PRODUCT_FOLDERS,
  },
  {
    key: "project",
    label: "A shared project",
    summary: "The five standard folders and nothing more: one piece of work with a finish line.",
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

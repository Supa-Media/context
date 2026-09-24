/**
 * Rendering `index.md` and the per-folder `README.md`s a fresh context starts
 * with.
 *
 * Split out of `lib/scaffold.ts` — see that file's header for the scaffolder's
 * overall rules.
 */

import { FOLDER_PURPOSE, PARA_FOLDERS, type ContextKind, type CustomFolder, type StructureTemplate } from "./store";

/* -------------------------------------------------------------------------- */
/*                                 index.md                                   */
/* -------------------------------------------------------------------------- */

/**
 * The manifest: what this context is, and one line per folder saying what
 * belongs in it.
 *
 * For a `custom` layout the owner's own folder names and one-line descriptions
 * take the place of the PARA ones, **verbatim** — they were validated before
 * they got here (`validateCustomFolders`), and rewording somebody's own
 * description in their own file would be as rude as renaming their folder.
 */
export function renderIndex(
  template: StructureTemplate,
  customFolders: readonly CustomFolder[] = [],
  kind: ContextKind = "personal",
): string {
  const shared = kind === "shared";
  const lines = [
    "---",
    "role: context-manifest",
    "version: 1",
    "---",
    "",
    shared ? "# Workspace" : "# Context",
    "",
    shared
      ? "This bucket is a shared workspace: plain Markdown files the workspace owns,"
      : "This bucket is a context: plain Markdown files you own, readable by any AI",
    shared
      ? "readable by any AI client its members connect. Nothing here is a database"
      : "client you connect. Nothing here is a database export — every file is a",
    shared
      ? "export — every file is a file, editable in Obsidian, in a text editor, or"
      : "file, editable in Obsidian, in a text editor, or over rclone.",
    ...(shared ? ["over rclone."] : []),
    "",
    "## Conventions",
    "",
    "- One idea per note. Notes are shared between many tools, so keep them",
    "  concise and factual.",
    ...(shared
      ? [
          "- Write for the next person, not for yourself. A note nobody else can",
          "  follow is why the workspace exists and why it stops being used.",
        ]
      : []),
    "- `privacy.md` decides what a connected client can see. Folder rules are",
    "  defaults; an exact note can override its folder.",
    ...(shared
      ? [
          "- Every folder listed below is readable by every member. A folder held",
          "  back to owners says `private` in `privacy.md`, and says so there only.",
        ]
      : []),
    "- Paths under `.context/` are product plumbing, never",
    "  notes, and are not shown to any client.",
    "",
  ];

  if (template === "para") {
    lines.push(
      "## Structure",
      "",
      "The starting shape is PARA. It is a suggestion, not a schema — rename",
      "these folders, nest them, or ignore them entirely. The tools address",
      "whatever paths exist.",
      "",
    );
    for (const folder of PARA_FOLDERS) {
      lines.push(`- \`${folder}/\` — ${FOLDER_PURPOSE[folder].line}`);
    }
    lines.push("");
  } else if (customFolders.length > 0) {
    lines.push(
      "## Structure",
      "",
      shared
        ? "These are the folders this workspace was set up with. They are a starting"
        : "These are the folders you named when you set this context up. They are a",
      shared
        ? "point, not a schema — rename them, nest inside them, add more, or delete"
        : "starting point, not a schema — rename them, nest inside them, add more, or",
      shared
        ? "them. The tools address whatever paths exist."
        : "delete them. The tools address whatever paths exist.",
      "",
    );
    for (const entry of customFolders) {
      lines.push(`- \`${entry.folder}/\` — ${entry.description}`);
    }
    lines.push("");
  } else {
    lines.push(
      "## Structure",
      "",
      "This context has no imposed folder structure. Create whatever paths suit",
      "the work; the tools address paths, not a taxonomy.",
      "",
    );
  }

  return lines.join("\n");
}

/**
 * A folder the owner named. Their description, verbatim, as the whole body.
 *
 * Deliberately shorter than the PARA READMEs: those explain a method the reader
 * may not know, whereas this folder's purpose is something its owner just wrote
 * down in their own words a moment ago.
 */
export function renderCustomFolderReadme(entry: CustomFolder): string {
  return [
    `# ${entry.folder}`,
    "",
    entry.description,
    "",
    "You named this folder when you set this context up. Rename it, nest inside",
    "it, or delete it — the tools address paths, not a fixed taxonomy.",
    "",
  ].join("\n");
}

export function renderFolderReadme(folder: string): string {
  const purpose = FOLDER_PURPOSE[folder];
  return [
    `# ${purpose.title}`,
    "",
    purpose.blurb,
    "",
    "Examples:",
    ...purpose.examples.map((example) => `- ${example}`),
    "",
    "This folder is a suggestion. Rename it, nest inside it, or delete it — the",
    "tools address paths, not a fixed taxonomy.",
    "",
  ].join("\n");
}

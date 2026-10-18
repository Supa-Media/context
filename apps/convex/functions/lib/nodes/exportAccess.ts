/**
 * The `access.md` a "Download as folders" archive carries in rows mode.
 *
 * In rows mode the rows are the truth and `privacy.md` is not what decides
 * anything, so an archive that dropped the file would also drop the only
 * place a person reads who can see what. This writes that list from the rows
 * instead: one line per row that carries its own setting, plain Markdown, the
 * way the archive's notes are plain Markdown.
 *
 * Who is named is the owner's to read. A member can open the notes they can
 * see, but not learn from the archive which other people were granted them,
 * so a member gets the count of grants and no names.
 */

export interface ExportAccessLine {
  /** The row's path: a note's, or a folder's without its trailing slash. */
  path: string;
  kind: "file" | "folder";
  /** The row's own base. Absent with a list, which reads as `private`. */
  base?: "private" | "team";
  /** Each grant, already labelled with its role, e.g. `@kola (view)`. */
  grants: string[];
}

export interface ExportAccessOptions {
  /** Whether grantee names are written. Owners only; everyone else gets a count. */
  names: boolean;
}

/** The `access.md` for these rows, sorted by path. */
export function renderAccessMarkdown(lines: readonly ExportAccessLine[], options: ExportAccessOptions): string {
  const sorted = [...lines].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = sorted.map((line) => `- ${displayPath(line)} — ${describe(line, options.names)}`);
  const intro =
    "Who can see what, from this workspace's access settings when the archive was made. " +
    "A path not listed here takes the setting of its nearest listed folder, and private when no folder above it is listed.";
  return [
    "# Access",
    "",
    intro,
    "",
    ...(body.length === 0 ? ["No path has a setting of its own."] : body),
    "",
  ].join("\n");
}

function displayPath(line: ExportAccessLine): string {
  return line.kind === "folder" ? `${line.path}/` : line.path;
}

function describe(line: ExportAccessLine, names: boolean): string {
  const base = line.base ?? "private";
  if (line.grants.length === 0) return base;
  if (names) return `${base}, plus ${line.grants.join(", ")}`;
  const count = line.grants.length;
  return `${base}, plus ${count} named ${count === 1 ? "person or group" : "people or groups"}`;
}

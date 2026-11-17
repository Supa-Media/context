/**
 * A WORKSPACE'S OWN RULES COME WITH THE FIRST CALL INTO IT (Dev2, 2026-11-17).
 *
 * In a 1:1 chat Tex made a project in a shared workspace with a layout of its own invention: tasks as checkboxes in
 * the overview, where that workspace's index.md says one note per task, linked from the overview. Tex never called
 * orient there and never read the index, though its prompt says to follow each workspace's index.md. So a texted or
 * group turn's first call into another workspace is answered with that workspace's conventions attached: its
 * `index.md`, `about.md` and `README.md` at the top, and the same three in each folder on the way to the path the
 * call names (Dev2: "its not just index, its index, about, readme"), each once a turn, read through the turn's own
 * dispatcher so its permission checks apply, and capped. A file that is not there, or not visible, adds nothing.
 */

/** The files that say how a workspace, or one of its folders, is kept. */
export const CONVENTION_FILES = Object.freeze(["index.md", "about.md", "README.md"]);
/** The most of one file shown, and of everything attached to one result. */
export const MAX_CONVENTION_FILE = 2_500;
export const MAX_CONVENTIONS = 8_000;
/** Folders read on the way to a path, from the top: deeper ones are the project's own notes. */
const MAX_DEPTH = 3;

const PATH_NAMED = /^@([a-z0-9][a-z0-9-]*)\//i;
const PATH_FIELDS = ["path", "id", "note", "prefix", "source", "destination", "folder"];

/** The workspace a call names (`context: "@x"` or an `@x/` path), without the `@`, or null for the turn's own. */
function workspaceOf(args) {
  const named = typeof args?.context === "string" ? args.context.trim().replace(/^@/, "") : "";
  if (named !== "") return named.toLowerCase();
  for (const field of PATH_FIELDS) {
    const match = typeof args?.[field] === "string" ? PATH_NAMED.exec(args[field].trim()) : null;
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/** The folders on the way to the path a call names, from the top ("" first), at most `MAX_DEPTH` below it. */
export function foldersOnTheWay(args) {
  const raw = PATH_FIELDS.map((field) => args?.[field]).find((value) => typeof value === "string" && value.trim() !== "");
  const path = typeof raw === "string" ? raw.trim().replace(PATH_NAMED, "").replace(/^\/+/, "") : "";
  const parts = path.split("/").filter(Boolean);
  const folders = path.endsWith("/") || args?.prefix !== undefined ? parts : parts.slice(0, -1);
  return ["", ...folders.slice(0, MAX_DEPTH).map((_, i) => `${folders.slice(0, i + 1).join("/")}/`)];
}

/** A read's body, without its header lines (`etag:`, `path:` … up to the first blank line). */
function bodyOf(result) {
  if (!result || result.isError === true) return "";
  const text = String(result?.content?.[0]?.text ?? "");
  const cut = text.indexOf("\n\n");
  const body = (cut === -1 ? "" : text.slice(cut + 2)).trim();
  return body.length > MAX_CONVENTION_FILE ? `${body.slice(0, MAX_CONVENTION_FILE)}\n… (cut; read the note for the rest)` : body;
}

/**
 * Wraps a texted or group turn's dispatcher. `own` is the turn's own workspace name (no `@`): its own index reaches
 * Tex another way. One per turn.
 */
export function withWorkspaceConventions(callTool, { own = null } = {}) {
  const home = typeof own === "string" ? own.trim().replace(/^@/, "").toLowerCase() : "";
  const seen = new Set();
  return async (name, args) => {
    const result = await callTool(name, args);
    const where = workspaceOf(args);
    if (where === null || where === home) return result;
    const wanted = foldersOnTheWay(args).filter((folder) => !seen.has(`${where}\n${folder}`));
    if (wanted.length === 0) return result;
    for (const folder of wanted) seen.add(`${where}\n${folder}`);
    const reads = wanted.flatMap((folder) => CONVENTION_FILES.map((file) => `${folder}${file}`));
    const bodies = await Promise.all(
      reads.map((path) => Promise.resolve(callTool("read_note", { path, context: `@${where}` })).then(bodyOf, () => "")),
    );
    let room = MAX_CONVENTIONS;
    const shown = [];
    for (const [i, body] of bodies.entries()) {
      if (body === "" || room <= 0) continue;
      const part = `--- @${where}/${reads[i]} ---\n${body.slice(0, room)}`;
      room -= part.length;
      shown.push(part);
    }
    if (shown.length === 0) return result;
    console.log(JSON.stringify({ event: "workspace_conventions", files: shown.length }));
    const note =
      `\n\nHow @${where} is kept, from its own notes (read once this turn; follow these over your own layout when you write here, and use its folder names):\n\n` +
      shown.join("\n\n");
    const content = Array.isArray(result?.content) ? result.content : [];
    const first = content[0]?.type === "text" ? { ...content[0], text: `${content[0].text}${note}` } : { type: "text", text: note.trim() };
    return { ...result, content: [first, ...content.slice(content[0]?.type === "text" ? 1 : 0)] };
  };
}

/** The turn's own workspace name from its contexts list (`store.contexts`), or null. */
export function ownWorkspaceName(contexts) {
  const own = (Array.isArray(contexts) ? contexts : []).find((entry) => entry?.current)?.name;
  return typeof own === "string" && own.trim() !== "" ? own.trim().replace(/^@/, "") : null;
}

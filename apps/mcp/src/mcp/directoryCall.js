import { directoryTools } from "./directoryTools.js";
import { callToolForSession } from "../tools/session.js";
import { contextsFor, personalNameFor } from "../context/identity.js";
import { validateArguments } from "../toolArguments.js";
import { normalizePath } from "../notes/paths.js";
import { parseFormBlocks } from "../forms.js";
import { toolError } from "../tools/results.js";

const textOf = (result) => result?.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";
const noteUrl = (workspace, path) => `https://context.lc/console/${encodeURIComponent(workspace.startsWith("@") ? workspace : `@${workspace}`)}?note=${encodeURIComponent(path)}`;
const structured = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const ordinaryPath = (path) => typeof path === "string" && !path.startsWith("@") && normalizePath(path) === path && path.endsWith(".md") && !path.endsWith(".page.md") && !/(^|\/)(?:\.|website(?:\/|$)|tex(?:\/|$))/.test(path) && path !== "privacy.md";

/** Public directory calls translate only after their own exact schema passes. Every translated call uses the existing authority path. */
export async function directoryCall(params, store, session) {
  const tool = directoryTools(session).find(t => t.name === params?.name);
  if (!tool) return toolError("Tool unavailable on this endpoint or connection.");
  const args = params.arguments ?? {};
  if (["update_note", "move_note", "archive_note"].includes(params.name) && (typeof args.expected_etag !== "string" || !args.expected_etag.trim())) return toolError("A non-empty current etag is required.");
  const invalid = validateArguments(tool.inputSchema, args);
  if (invalid) return toolError(invalid);
  const context = args.workspace === undefined ? {} : { context: args.workspace };
  const invoke = (name, input, options = {}) => callToolForSession({ name, arguments: input }, store, session, { legacy: true, ...options });
  switch (params.name) {
    case "get_profile": {
      if (typeof session.actorUserId !== "string" || !session.actorUserId.trim()) return toolError("Account identity unavailable.");
      const name = personalNameFor(session);
      return structured({ id: session.actorUserId, ...(name ? { name } : {}) });
    }
    case "list_workspaces": return structured({ workspaces: contextsFor(session) });
    case "get_workspace_overview": {
      const front = await invoke("read_note", { path: "index.md", ...context });
      if (front.isError) return front;
      const notes = await invoke("list_notes", context);
      if (notes.isError) return notes;
      return structured({ front_page: textOf(front), notes: textOf(notes) });
    }
    case "list_notes": {
      const result = await invoke("list_notes", { ...context, ...(args.folder ? { prefix: args.folder } : {}) });
      if (result.isError) return result;
      const rows = textOf(result).split("\n").filter(row => /\.md \(\d+ bytes\)$/.test(row));
      const offset = args.cursor === undefined ? 0 : Number(args.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) return toolError("Invalid pagination cursor.");
      const limit = args.limit ?? 50;
      return structured({ notes: rows.slice(offset, offset + limit), next_cursor: offset + limit < rows.length ? String(offset + limit) : null });
    }
    case "search": {
      const contexts = contextsFor(session);
      const sources = contexts.length ? contexts.map(c => c.name) : [null];
      const answers = await Promise.all(sources.map(async workspace => {
        const result = await invoke("search", { query: args.query, ...(workspace ? { context: workspace } : {}) });
        if (result.isError) return [];
        try {
          return JSON.parse(textOf(result)).results.map(hit => ({
            ...hit, id: workspace ? `${workspace}/${hit.id}` : hit.id,
            url: noteUrl(workspace ?? session.workspaceSlug ?? "context", hit.id),
          }));
        } catch { return []; }
      }));
      return structured({ results: answers.flat().slice(0, 50) });
    }
    case "fetch": {
      const id = args.id;
      const named = id.match(/^(@[a-z0-9-]+)\/(.+)$/);
      const path = named ? named[2] : id;
      if (!ordinaryPath(path) && path !== "index.md") return toolError("Invalid note identifier.");
      const result = await invoke("read_note", { path, ...(named ? { context: named[1] } : {}) });
      if (result.isError) return result;
      const words = textOf(result);
      const etag = words.match(/^etag: (.+)$/m)?.[1];
      return structured({ id, title: path.split("/").at(-1), text: words, url: noteUrl(named ? named[1] : session.workspaceSlug ?? "context", path), metadata: { ...(etag ? { etag } : {}) } });
    }
    case "create_note":
    case "update_note": {
      if (!ordinaryPath(args.path)) return toolError("This endpoint writes ordinary Markdown notes only.");
      if (parseFormBlocks(args.content).length) return toolError("Form creation is not available through note writes on this endpoint.");
      return invoke("write_note", { path: args.path, content: args.content, ...context, ...(args.expected_etag ? { expected_etag: args.expected_etag } : {}) }, { noteWrite: { mustCreate: params.name === "create_note" } });
    }
    case "move_note": {
      if (!ordinaryPath(args.path) || !ordinaryPath(args.destination)) return toolError("Only ordinary notes in the same workspace may be moved.");
      return invoke("move_note", { source: args.path, destination: args.destination, expected_source_etag: args.expected_etag, ...context });
    }
    case "archive_note": {
      if (!ordinaryPath(args.path)) return toolError("Only ordinary notes may be archived.");
      return invoke("archive_note", { path: args.path, expected_etag: args.expected_etag, ...context });
    }
  }
}

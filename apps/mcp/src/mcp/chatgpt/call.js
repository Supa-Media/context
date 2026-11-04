import { chatgptTools } from "./tools.js";
import { chatgptOperations } from "./operations.js";
import { callToolForSession } from "../../tools/session.js";
import { contextsFor, personalNameFor } from "../../context/identity.js";
import { validateArguments } from "../../toolArguments.js";
import { toolError } from "../../tools/results.js";

const textOf = r => r?.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";
const structured = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const urlFor = (workspace, path) => `https://context.lc/console/${encodeURIComponent(workspace?.startsWith("@") ? workspace : `@${workspace ?? "context"}`)}?note=${encodeURIComponent(path)}`;
const addressKeys = ["context", "mailbox", "person_said"];

/** One fixed, advertised operation, through the existing routing/permission/approval gates. */
export async function chatgptCall(params, store, session) {
  const tools = await chatgptTools(session, store);
  const tool = tools.find(t => t.name === params?.name);
  if (!tool) return toolError("Tool unavailable on this endpoint or connection. orient describes the exposed operations.");
  const args = params.arguments ?? {};
  const invalid = validateArguments(tool.inputSchema, args);
  if (invalid) return toolError(invalid);
  const op = chatgptOperations().find(t => t.name === tool.name);
  const invoke = (name, arguments_, options = {}) => callToolForSession({ name, arguments: arguments_ }, store, session, { legacy: true, ...options });
  const address = Object.fromEntries(addressKeys.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
  if (op.custom === "profile") {
    if (!session.actorUserId) return toolError("Account identity unavailable.");
    const name = personalNameFor(session);
    return structured({ id: session.actorUserId, ...(name ? { name } : {}) });
  }
  if (op.custom === "workspaces") return structured({ workspaces: contextsFor(session) });
  if (op.custom === "search") {
    const contexts = args.context ? [args.context] : contextsFor(session).map(c => c.name);
    const results = await Promise.all((contexts.length ? contexts : [null]).map(async context => {
      const answer = await invoke("search", { query: args.query, ...(context ? { context } : {}), ...(args.prefix ? { args: { prefix: args.prefix } } : {}), ...(args.mailbox ? { mailbox: args.mailbox } : {}) });
      if (answer.isError) return { error: answer };
      try { return JSON.parse(textOf(answer)).results.map(hit => ({ ...hit, id: context ? `${context}/${hit.id}` : hit.id, url: urlFor(context ?? session.workspaceSlug, hit.id) })); }
      catch { return []; }
    }));
    if (args.context && results[0]?.error) return results[0].error;
    const failed = results.filter(row => row.error).length;
    return structured({ results: results.filter(Array.isArray).flat().slice(0, 50), ...(failed ? { warning: "Some accessible workspaces could not be searched; these results may be incomplete." } : {}) });
  }
  if (op.custom === "fetch") {
    // No discovery + executor escape through the ordinary fetch vocabulary.
    const named = args.id.match(/^(@[a-z0-9-]+)\/(.*)$/);
    const id = named ? named[2] : args.id;
    if (id.trim().startsWith("apps:")) return toolError("Dynamic connected-app calls are excluded from this endpoint. Use a separately exposed read tool or the ordinary MCP endpoint.");
    const answer = await callToolForSession({ name: "fetch", arguments: { id, args: {}, ...address, ...(named ? { context: named[1] } : {}) } }, store, session);
    if (answer.isError) return answer;
    const text = textOf(answer);
    const etag = text.match(/^etag: (.+)$/m)?.[1];
    return { ...structured({ id: args.id, title: id.split("/").at(-1), text, url: urlFor(named?.[1] ?? args.context ?? session.workspaceSlug, id), metadata: { ...(etag ? { etag } : {}) } }), ...(answer.held ? { held: true } : {}) };
  }
  if (op.custom === "save_many") {
    return callToolForSession({ name: "write", arguments: { action: "save_many", args: { notes: args.notes }, ...address } }, store, session);
  }
  if (op.custom === "upload") return invoke("write_note", { path: args.path, upload: args.files, ...address });
  if (op.custom === "slack") {
    const { limit, team, context, mailbox, person_said, ...payload } = args;
    return invoke("slack_api", { ...op.fixed, args: payload, ...(limit === undefined ? {} : { limit }), ...(team === undefined ? {} : { team }), ...address });
  }
  if (op.nested) {
    const payload = Object.fromEntries(Object.entries(args).filter(([k]) => !addressKeys.includes(k) && k !== "path"));
    return invoke(op.target, { path: args.path ?? "website/index.md", [op.nested]: { ...payload, ...op.fixed }, ...address });
  }
  if (op.custom === "create" || op.custom === "update") {
    if (op.custom === "update" && !args.expected_etag?.trim()) return toolError("A non-empty current etag is required.");
    return invoke("write_note", args, { noteWrite: { mustCreate: op.custom === "create" } });
  }
  return invoke(op.target, { ...args, ...op.fixed });
}

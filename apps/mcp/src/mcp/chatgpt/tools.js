import { toolDefinitions } from "../../tools/registry.js";
import { toolsForSession } from "../../tools/advertised.js";
import { hasScope, SCOPE_WRITE } from "../../session.js";
import { ACTIONS } from "../../tools/v2/actions.js";
import { chatgptOperations } from "./operations.js";

const address = ["context", "mailbox", "person_said"];
const base = new Map(toolDefinitions().map(t => [t.name, t]));
const str = { type: "string" };

function metadataWords(text) {
  return text.replaceAll("write_note", "create_note or update_note")
    .replaceAll("search_notes", "search")
    .replaceAll("google_chat action spaces", "list_google_chat_spaces")
    .replaceAll("fetch apps:", "list_connected_apps")
    .replaceAll("write action mail, args { join }", "join_note_mail");
}

function close(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(close);
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === "description" && typeof v === "string" ? metadataWords(v) : close(v)]));
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

export function operationSchema(op) {
  if (op.custom === "profile" || op.custom === "workspaces") return { type: "object", properties: {}, additionalProperties: false };
  const original = base.get(op.target).inputSchema;
  let source = op.nested ? original.properties[op.nested] : original;
  let fields = op.fields ?? Object.keys(source.properties ?? {}).filter(k => !Object.hasOwn(op.fixed ?? {}, k));
  let required = op.required ?? (source.required ?? []).filter(k => fields.includes(k));
  let properties = Object.fromEntries([...new Set([...fields, ...address])].filter(k => source.properties?.[k] || original.properties?.[k]).map(k => [k, source.properties?.[k] ?? original.properties[k]]));
  if (op.nested && op.nested !== "site") properties.path = original.properties.path;
  if (op.custom === "search") {
    const p = base.get("search_notes").inputSchema.properties;
    properties = Object.fromEntries(["query", "prefix", ...address].map(k => [k, p[k]])); required = ["query"];
  }
  if (op.custom === "fetch") {
    properties = { id: str, context: original.properties.context, mailbox: original.properties.mailbox };
    required = ["id"];
  }
  if (op.custom === "save_many") {
    properties = { ...ACTIONS.write.save_many.carrier.inputSchema.properties, ...Object.fromEntries(address.map(k => [k, original.properties[k]])) }; required = ["notes"];
  }
  if (op.custom === "upload") {
    properties = { path: original.properties.path, files: original.properties.upload, ...Object.fromEntries(address.map(k => [k, original.properties[k]])) }; required = ["path", "files"];
  }
  if (op.custom === "slack") {
    const p = original.properties;
    const fields = {
      "users.list": ["match", "include_inactive", "cursor"], "users.info": ["user"], "users.lookupByEmail": ["email"],
      "conversations.list": ["match", "types", "cursor", "include_inactive"], "conversations.info": ["channel"],
      "conversations.history": ["channel", "oldest", "latest", "cursor"], "conversations.replies": ["channel", "ts", "oldest", "latest", "cursor"],
      "search.messages": ["query"], "chat.getPermalink": ["channel", "message_ts"],
      "chat.postMessage": ["channel", "text", "thread_ts", "blocks"], "chat.update": ["channel", "ts", "text", "blocks"],
      "chat.delete": ["channel", "ts"], "chat.scheduleMessage": ["channel", "text", "post_at", "thread_ts", "blocks"],
      "chat.meMessage": ["channel", "text"], "reactions.add": ["channel", "timestamp", "name"], "reactions.remove": ["channel", "timestamp", "name"],
    }[op.fixed.method];
    properties = { ...Object.fromEntries(fields.map(k => [k, p.args.properties[k]])), limit: p.limit, team: p.team, ...Object.fromEntries(address.map(k => [k, p[k]])) };
    required = fields.filter(k => ["channel", "ts", "timestamp", "name", "query", "user", "email", "message_ts", "post_at"].includes(k));
    if (["chat.postMessage", "chat.scheduleMessage", "chat.meMessage"].includes(op.fixed.method)) required.push("text");
  }
  if (op.name === "save_context") properties.content = { type: "string", minLength: 1, maxLength: 12000, description: "Concise task-specific decisions and outcomes the user requested saving; no raw conversation history." };
  if (op.name === "orient") properties.about = { type: "string", description: "tools, access, website, pages, health, or the name of one exposed tool. Omit for the workspace overview." };
  return close({ type: "object", properties, required, additionalProperties: false });
}

export async function chatgptTools(session, store) {
  const offered = await toolsForSession(session, store, { shape: "all" });
  const names = new Set(offered.map(t => t.name));
  return chatgptOperations().filter(op => !op.target || names.has(op.target)).filter(op => op.name !== "report_problem" || hasScope(session, SCOPE_WRITE)).map(op => {
    const inherited = base.get(op.target);
    const readOnly = op.readOnly ?? inherited?.annotations.readOnlyHint ?? true;
    const title = op.name === "orient" ? "Orient in your Context" : op.name.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
    const description = op.description ?? inherited?.description ?? (op.name === "get_profile" ? "Identify the account represented by this authenticated connection, using a stable account ID and display label." : "List all workspaces this connection may access, with its roles and selected workspace.");
    return {
      name: op.name, title, description: metadataWords(description),
      inputSchema: operationSchema(op),
      annotations: { title, readOnlyHint: readOnly, destructiveHint: readOnly ? false : op.destructive ?? true, openWorldHint: op.openWorld ?? inherited?.annotations.openWorldHint ?? false },
      securitySchemes: [{ type: "oauth2", scopes: readOnly ? ["context:read"] : ["context:read", "context:write"] }],
      ...(op.name === "get_profile" ? { _meta: { "openai/profile": true }, outputSchema: { type: "object", properties: { id: str, name: str }, required: ["id"], additionalProperties: false } } : {}),
    };
  });
}

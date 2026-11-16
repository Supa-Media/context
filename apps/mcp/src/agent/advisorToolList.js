/**
 * THE TURN'S REAL TOOLS, AS THE ADVISOR AND THE JOB CHECK READ THEM (a job's log, 2026-11-16).
 *
 * The advisor was shown the turn's tools by name only (`fetch, send, ...`), so it advised from what it imagined each
 * one took: it told a job to fetch an email with `{ links: true }`, an argument no tool has, and to `read_back` earlier
 * reads, which that job's tool list did not show. The owner: "I'm confused how the advisor does not have access to
 * the tool set. That sounds like a harness issue."
 *
 * So each tool the turn was offered is listed with what the model itself reads: its first paragraph, each parameter
 * with its type, its enum and the start of its description, and, for the six's families (`sixTools.js`), each action
 * the turn holds with its own arguments. Compact and capped: it sits beside a transcript that may be long. Only what
 * the turn was offered is listed, so a tool it lacks can never be advised.
 *
 * Whether a step is shown the list is the config's, never code's (the owner, 2026-11-16): a step reads it when its
 * `ctx` in `texConfig.json` names "tools" (`readsTools`), main's or a Lab draft's; without it, no list at all.
 */

import { TEX_CONFIG, texStep } from "./texConfig.js";

/** Whether step `id` reads the turn's tools in `config` (main's, or a Lab test chat's draft): its ctx names "tools". */
export function readsTools(id, config = TEX_CONFIG) {
  const ctx = texStep(id, config).ctx;
  return Array.isArray(ctx) && ctx.includes("tools");
}

/** The most of the whole list; a longer one keeps its first tools and says it was cut. */
export const MAX_TOOL_LIST_CHARS = 16_000;
const MAX_SUMMARY_CHARS = 300;
const MAX_PARAM_CHARS = 200;
const MAX_ACTION_CHARS = 320;
const MAX_ENUM = 24;

const clip = (text, max) => {
  const said = String(text ?? "").replace(/\s+/g, " ").trim();
  return said.length > max ? `${said.slice(0, max - 1)}…` : said;
};

/** The first paragraph of a description. */
function summary(description) {
  const text = typeof description === "string" ? description : "";
  const end = text.search(/\r?\n\s*\r?\n/);
  return clip(end === -1 ? text : text.slice(0, end), MAX_SUMMARY_CHARS);
}

/** One parameter: `name (type, one of a|b, required): its description's start`. */
function paramLine(name, schema, required, seen) {
  const type = Array.isArray(schema?.type) ? schema.type.join("|") : (schema?.type ?? "any");
  const values = Array.isArray(schema?.enum) ? schema.enum.slice(0, MAX_ENUM).map(String) : [];
  const kinds = [type, values.length > 0 ? `one of ${values.join("|")}${schema.enum.length > MAX_ENUM ? "|…" : ""}` : "", required ? "required" : ""].filter(Boolean);
  // A parameter every tool shares (context, mailbox) is described once: the list stays short.
  const whole = clip(schema?.description, MAX_PARAM_CHARS);
  const said = seen.has(`${name}:${whole}`) ? "as above" : whole;
  seen.add(`${name}:${whole}`);
  return `    ${name} (${kinds.join(", ")})${said ? `: ${said}` : ""}`;
}

/** The lines a description lists under "Your actions:" or "Also:" (`sixTools.js`), each one action or id. */
function listedLines(description) {
  const text = typeof description === "string" ? description : "";
  return text.split(/\r?\n/).filter((line) => /^- \S/.test(line)).map((line) => `    ${clip(line, MAX_ACTION_CHARS)}`);
}

/** One tool as the list shows it. */
function toolEntry(tool, seen) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const params = Object.entries(properties).map(([name, value]) => paramLine(name, value, required.has(name), seen));
  const listed = listedLines(tool.description);
  return [
    `- ${tool.name}: ${summary(tool.description) || "(no description)"}`,
    params.length > 0 ? `  takes:\n${params.join("\n")}` : "  takes: nothing",
    listed.length > 0 ? `  its actions and ids, each with its own args:\n${listed.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The turn's tools as one block of text, leaving out `skip` (the advisor's own tool), or "" when it was offered none.
 *
 * @param {Array<{name: string, description?: string, inputSchema?: object}>} tools what the turn's model was offered
 * @param {{skip?: string[], max?: number}} [options]
 */
export function toolList(tools, { skip = [], max = MAX_TOOL_LIST_CHARS } = {}) {
  const left = new Set(skip);
  const seen = new Set();
  const entries = (Array.isArray(tools) ? tools : []).filter((tool) => typeof tool?.name === "string" && !left.has(tool.name)).map((tool) => toolEntry(tool, seen));
  let text = "";
  for (const entry of entries) {
    if (text.length + entry.length + 1 > max) return `${text}(the rest of the tool list was cut)`;
    text += `${entry}\n`;
  }
  return text.trimEnd();
}

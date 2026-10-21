/**
 * `app_read` and `app_change`: an app the person connected through its own
 * official MCP server (Linear, Notion, Planning Center…), so its tools are
 * Tex's tools without a browser signed in as anybody
 * (`docs/decisions/connectors.md`).
 *
 * As with Slack (`connectors.js`), the gateway decides nothing about who may
 * use which connection: the control plane clears this connection's token,
 * picks the person's own connection (never from a group chat), adds the
 * app's token, and refuses a tool that is not marked read-only unless the
 * call is a change. A change is always held for the person's yes here first
 * (`irreversible.js`), because the gateway cannot know what a tool does.
 *
 * What an app's server says (its tool names, descriptions and answers) is the
 * app's text, shown to the model as data.
 */

import { oneLine } from "../privacy/egress.js";
import { MAX_ANSWER_CHARS } from "./connectors.js";
import { toolError, toolText } from "./results.js";

const APP = /^[a-z][a-z-]{1,30}[a-z]$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,100}$/;
/** Longest tool description shown in a list; the full schema is the app's. */
const DESCRIPTION_CHARS = 240;

const UNAVAILABLE = "Connected apps are not available on this deployment.";

const STATE_WORDS = {
  connected: "connected",
  reconnect: "stopped working; give them a new link from manage connect",
  not_connected: "not connected; manage connect gives the link",
  not_available: "can't be used from here (it connects for one person, from their own chat)",
};

function refusal(app, refused, { tool, message } = {}) {
  switch (refused) {
    case "not_connected":
      return `${app} is not connected for this person. Give them the link from manage connect (app ${app}) and ask them to tap it and approve.`;
    case "reconnect_required":
      return `${app} stopped accepting this connection. Give the person a new link from manage connect (app ${app}).`;
    case "needs_yes":
      return (
        `${tool} can change something in ${app}, so it is not a read. Send it with send app (or app_change), app, tool and arguments the same; ` +
        "it waits for the person's yes to exactly that."
      );
    case "unknown_tool":
      return `${app} has no tool called ${tool}. fetch apps:${app} lists its tools.`;
    case "too_large":
      return `${app}'s answer was too long to read. Ask for less: a narrower query, a smaller limit, or one item.`;
    case "method_not_allowed":
      return `${app} can't be called through Context. fetch apps: lists the apps that can.`;
    default:
      return `${app} could not be reached just now${message ? ` (${oneLine(String(message)).slice(0, 200)})` : ""}. Try again in a moment.`;
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The apps this deployment connects, and which this person has connected. */
async function catalog(calls) {
  let apps;
  try {
    apps = await calls.apps();
  } catch {
    return toolError("The list of apps could not be read just now. Try again in a moment.");
  }
  if (!Array.isArray(apps) || apps.length === 0) return toolText("No apps connect through Context on this deployment. Use the browser.");
  const lines = apps.map((entry) => {
    const how = entry.via === "api" ? ` (its own API: send ${entry.app}, or ${entry.app}_api)` : "";
    const account = entry.state === "connected" && entry.account ? ` as ${entry.account}` : "";
    return `- ${entry.name} (app ${entry.app}): ${STATE_WORDS[entry.state] ?? entry.state}${account}${how}. ${entry.about}`;
  });
  return toolText(
    "Apps Tex reaches through their own connection, not a browser:\n" +
      `${lines.join("\n")}\n` +
      "A connected app: fetch apps:<app> lists its tools; fetch apps:<app> with args { tool, arguments } runs a read; " +
      "send app { app, tool, arguments } makes a change, after the person's yes (app_read and app_change, called directly). " +
      "An app listed here but not connected: send them the link from manage connect, never its sign-in page in a browser. " +
      "Anything not listed here: use the browser.",
  );
}

/** A compact line per tool: name, read or change, its arguments, and what it does. */
function toolLines(app, tools) {
  return tools.map((tool) => {
    const schema = plainObject(tool.inputSchema) ? tool.inputSchema : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const props = plainObject(schema.properties) ? Object.entries(schema.properties) : [];
    const args = props.map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${plainObject(value) && typeof value.type === "string" ? value.type : "any"}`);
    const words = oneLine(String(tool.description ?? "")).slice(0, DESCRIPTION_CHARS);
    return `- ${tool.name} [${tool.readOnly === true ? "read" : "change"}] { ${args.join(", ")} } ${words}`;
  });
}

/** An MCP `tools/call` result as words: its text parts, or its structured answer. */
function resultText(body) {
  if (!plainObject(body)) return JSON.stringify(body ?? null);
  if (Array.isArray(body.content)) {
    const parts = body.content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part)));
    if (parts.length > 0) return parts.join("\n");
  }
  if (body.structuredContent !== undefined) return JSON.stringify(body.structuredContent);
  return JSON.stringify(body);
}

/** `{app, tool, arguments}` as the caller sent them, checked; or an error's words. */
function callOf(args, { needTool }) {
  const app = typeof args?.app === "string" ? args.app.trim().toLowerCase() : "";
  if (!APP.test(app)) return { error: "app is an app id from fetch apps:, e.g. linear." };
  const tool = typeof args.tool === "string" ? args.tool.trim() : "";
  if (tool === "" && needTool) return { error: `tool is one of the tools fetch apps:${app} lists.` };
  if (tool !== "" && !TOOL.test(tool)) return { error: `tool is one of the tools fetch apps:${app} lists.` };
  const given = args.arguments === undefined ? {} : args.arguments;
  if (!plainObject(given)) return { error: "arguments is an object of the tool's own arguments." };
  return { app, tool, arguments: given };
}

async function run(calls, call, change) {
  const request =
    call.tool === ""
      ? { provider: call.app, method: "tools.list", args: {} }
      : { provider: call.app, method: "tools.call", args: { name: call.tool, arguments: call.arguments, change } };
  let answer;
  try {
    answer = await calls.call(request);
  } catch {
    return toolError(refusal(call.app, "unavailable"));
  }
  if (answer?.ok !== true) return toolError(refusal(call.app, answer?.refused, { tool: call.tool, message: answer?.message }));
  if (call.tool === "") {
    const tools = Array.isArray(answer.body?.tools) ? answer.body.tools : [];
    const text = `${call.app} tools ([read] runs at once; [change] goes through send app and waits for a yes):\n${toolLines(call.app, tools).join("\n")}`;
    return text.length > MAX_ANSWER_CHARS ? toolText(`${text.slice(0, MAX_ANSWER_CHARS)}\n…(more tools not shown)`) : toolText(text);
  }
  const text = resultText(answer.body);
  if (text.length > MAX_ANSWER_CHARS) return toolError(refusal(call.app, "too_large"));
  const words = `${call.app} answered ${call.tool}:\n${text}`;
  return answer.body?.isError === true ? toolError(words) : toolText(words);
}

/** No app: the catalog. An app alone: its tools. With a tool: one read. */
export async function toolAppRead(store, args) {
  const calls = store?.connectors;
  if (!calls) return toolError(UNAVAILABLE);
  if (args?.app === undefined || args.app === "") return catalog(calls);
  const call = callOf(args, { needTool: false });
  if (call.error) return toolError(call.error);
  return run(calls, call, false);
}

/** One change through a connected app; held for the person's yes before it gets here. */
export async function toolAppChange(store, args) {
  const calls = store?.connectors;
  if (!calls) return toolError(UNAVAILABLE);
  const call = callOf(args, { needTool: true });
  if (call.error) return toolError(call.error);
  return run(calls, call, true);
}

/** What a held change would do, in the words the person says yes to. */
export function appHeldSummary(args) {
  const call = callOf(plainObject(args) ? args : {}, { needTool: true });
  if (call.error) return null;
  const shown = JSON.stringify(call.arguments);
  return oneLine(`use ${call.tool} in ${call.app}${shown === "{}" ? "" : ` with ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}`}`);
}

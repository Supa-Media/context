/**
 * TEX'S TOOLS MEASURED AGAINST THE FOUR TOOL RULES (Dev2, 2026-11-20; `packages/tex/src/toolRules.cjs`).
 *
 * Runs real turns through the replay harness (`test/replay/chats.mjs`) and reads the tool definitions each one sent to
 * the model, so rule 1 and rule 2 are measured on what a model is actually shown, not on a list kept by hand. Rule 3
 * and rule 4 read the code. `toolRules.test.mjs` holds the result against `baseline.json`, which may only get better;
 * `node scripts/tool-rules.mjs --write` rewrites it after a fix.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { oneToOne, groupChat } from "../replay/chats.mjs";
import { toolDefinitions } from "../../src/tools/registry.js";
import { V2_TOOLS } from "../../src/tools/advertised.js";
import { ASSISTANT_SEND_ACTIONS } from "../../src/agent/sixTools.js";
import rules from "../../../../packages/tex/src/toolRules.cjs";

const { TOOL_CHAR_LIMIT, toolChars, rateError, TEX_STATE_FILES, SHELL_NAMES } = rules;
const MCP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const print = (value) => createHash("sha256").update(JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner))).digest("hex").slice(0, 8);

/** Every model call answers with words, or the judges' JSON, so each turn runs to its end. */
const ANSWER = Array.from({ length: 60 }, () => (request) => ({ text: request.tools?.length ? "Done." : '{"ok":true}' }));

const MAIL = {
  address: "ada@example.invalid",
  id: "rules-1",
  date: "Wed, 18 Nov 2026 15:00:00 +0000",
  from: "Harbor office <harbor@example.invalid>",
  to: "ada@example.invalid",
  subject: "Slip 12 approved",
  snippet: "Approved. The note does not say which dock.",
};

/** The first model request of a run that carried tools: what Tex's model was shown. */
function firstToolList(requests) {
  const request = requests.find((one) => Array.isArray(one.tools) && one.tools.length > 0);
  return request ? request.tools : null;
}

async function quietly(run) {
  const log = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

/** Each kind of turn, by the chat it runs in: rule 1 asks that one chat's turns all see the same tools. */
export async function surfaces() {
  const shown = {};
  const chat = await oneToOne();
  try {
    const take = async (name, run) => {
      const before = chat.world.model.requests.length;
      await run().catch(() => null);
      shown[name] = { chat: "1:1", tools: firstToolList(chat.world.model.requests.slice(before)) };
    };
    await take("1:1 text", () => chat.text("what's on my plate this week?", ANSWER));
    await take("job part", () => chat.jobPart("find a dentist", { id: "job_rules", title: "Find a dentist", brief: "Find a dentist near them", attempt: 1, part: 1, followUps: [] }, ANSWER));
    chat.atNow();
    await take("check-in", () => chat.checkIn(ANSWER, { mail: [MAIL] }));
  } finally {
    chat.restore();
  }
  const group = await groupChat();
  try {
    const before = group.model.requests.length;
    await group.tag("Ada", "@tex what's the plan saturday?", ANSWER, [], { tagged: true }).catch(() => null);
    shown["group text"] = { chat: "group", tools: firstToolList(group.model.requests.slice(before)) };
  } finally {
    group.restore();
  }
  return shown;
}

/** Model-facing error strings in the gateway's Tex and tool code: refusals, `{ error }` and `textResult(…, true)`. */
const ERROR_SHAPES = [
  /textResult\(\s*([`"'])((?:\\.|(?!\1).)*)\1\s*,\s*true/g,
  /\berror:\s*([`"'])((?:\\.|(?!\1).)*)\1/g,
  /(?:refuse|refusal|refused|toolError|errorResult)\w*\(\s*([`"'])((?:\\.|(?!\1).)*)\1/g,
  /const [A-Z_]*(?:REFUSAL|REFUSED|TIMED_OUT|OUT_OF_TIME)[A-Z_]*\s*=\s*([`"'])((?:\\.|(?!\1).)*)\1/g,
];
/** Codes the gateway answers a Worker or the app with, never a model: "daily_limit", "bad_request". */
const CODE = /^[a-z][a-z0-9_]*$/;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".js") ? [join(dir, entry.name)] : []));
}

export function errorStrings() {
  const found = new Map();
  for (const file of ["src/agent", "src/tools", "src/machines"].flatMap((dir) => files(join(MCP_ROOT, dir)))) {
    const source = readFileSync(file, "utf8");
    for (const shape of ERROR_SHAPES) {
      for (const match of source.matchAll(shape)) {
        const text = match[2];
        if (text.length < 8 || CODE.test(text) || found.has(text)) continue;
        found.set(text, { file: relative(MCP_ROOT, file), text, rating: rateError(text) });
      }
    }
  }
  return [...found.values()];
}

/** The whole report: what each rule measures today. */
export async function toolRulesReport() {
  const shown = await quietly(surfaces);
  const sizes = {};
  const prints = {};
  for (const [name, { tools }] of Object.entries(shown)) {
    if (!tools) continue;
    sizes[name] = Object.fromEntries(tools.map((tool) => [tool.name, toolChars(tool)]));
    prints[name] = { list: print(tools), each: Object.fromEntries(tools.map((tool) => [tool.name, print(tool)])) };
  }
  // Rule 1: within one chat, how many different lists its kinds of turn were shown, and which tools differed.
  const fixedList = {};
  for (const chat of ["1:1", "group"]) {
    const kinds = Object.entries(shown).filter(([name, one]) => one.chat === chat && prints[name]).map(([name]) => name);
    const lists = new Set(kinds.map((name) => prints[name].list));
    const names = new Set(kinds.flatMap((name) => Object.keys(prints[name].each)));
    const differ = [...names].filter((tool) => new Set(kinds.map((name) => prints[name].each[tool] ?? "missing")).size > 1).sort();
    fixedList[chat] = { kinds, lists: lists.size, differ };
  }
  // Rule 2: each tool a Tex turn is shown, and each tool an MCP client is listed.
  const mcp = Object.fromEntries(toolDefinitions().filter((tool) => V2_TOOLS.has(tool.name)).map((tool) => [tool.name, toolChars(tool)]));
  const over = [];
  for (const [surface, tools] of Object.entries(sizes)) for (const [tool, chars] of Object.entries(tools)) if (chars > TOOL_CHAR_LIMIT) over.push({ where: surface, tool, chars });
  for (const [tool, chars] of Object.entries(mcp)) if (chars > TOOL_CHAR_LIMIT) over.push({ where: "mcp", tool, chars });
  // Rule 3: Tex's state files with no dedicated action, and any tool or send action that would hand a model a shell.
  const shells = [
    ...toolDefinitions().map((tool) => tool.name),
    ...Object.keys(ASSISTANT_SEND_ACTIONS),
    ...Object.values(shown).flatMap((one) => (one.tools ?? []).map((tool) => tool.name)),
  ].filter((name) => SHELL_NAMES.includes(name));
  const state = { generic: TEX_STATE_FILES.filter((entry) => entry.action === null).map((entry) => entry.file), shells: [...new Set(shells)] };
  // Rule 4: every model-facing error string, rated; a file's count of ones that don't say what to do next.
  const errors = errorStrings();
  const byFile = {};
  for (const error of errors) if (error.rating !== "actionable") byFile[error.file] = (byFile[error.file] ?? 0) + 1;
  const tally = (rating) => errors.filter((error) => error.rating === rating).length;
  return {
    limit: TOOL_CHAR_LIMIT,
    sizes,
    mcp,
    over,
    fixedList,
    state,
    errors: { total: errors.length, actionable: tally("actionable"), partial: tally("partial"), not: tally("not"), notActionableByFile: Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b))) },
  };
}

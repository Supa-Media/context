/**
 * The ability check, for the gold self-check (`setsGold.mjs`; Dev2, 2026-11-19). A Front door label whose must lines
 * need something Tex does not have (a search of the phone's contacts, when only Context contact pages are listed) can
 * never pass honestly, so it is marked impossible and kept out of the score rather than failed.
 *
 * Each such row is asked twice, as two separate calls of the same body (a `vote` line tells them apart, so the
 * bodies differ). A must line is impossible only when BOTH votes say it is, by index; one vote alone never marks a row.
 * The ability list is `CAPABILITIES` (`src/agent/capabilities.js`): what a listed ability does, and each can't that
 * applies to the chat's kind, so the check reads the same words Tex is told.
 */

import { CAPABILITIES } from "../src/agent/capabilities.js";

/** How many times a reply that is not parseable is asked again, as the gold judge does. */
export const ABILITY_ATTEMPTS = 3;
/** Each reply is a short JSON list of the must lines' verdicts. */
export const ABILITY_MAX_TOKENS = 1500;
/** The votes asked for each row: two separate calls, which must both agree before a line is impossible. */
export const ABILITY_VOTES = [1, 2];

/** The opening of the system prompt; `isAbilityBody` tells an ability request from a judge request by it. */
export const ABILITY_OPENING = "You decide whether a test's must lines can be met AT ALL by Tex";

export const ABILITY_SYSTEM = [
  `${ABILITY_OPENING}, a texting assistant, using only the abilities listed.`,
  "Judge ability only, never wording or quality.",
  "A line is impossible only when meeting it requires a tool, data source or access that no listed ability gives, or that the can't list names (for example searching the phone's address book when only Context contact pages are listed).",
  "Anything a listed ability, a background job with a web browser, or simply writing a text could do is possible.",
  "When unsure, it is possible.",
  'Reply with JSON only, in this shape: {"lines": [{"line": "<the must line, copied exactly>", "missing": "<the ability it needs, or an empty string when possible>", "possible": true or false}]}',
  "Give one entry per must line, in the order given.",
].join(" ");

/**
 * The shape the reply is held to by the API (structured outputs), as the judge's is: `missing` comes before `possible`,
 * so the reason is written before the verdict.
 */
export const ABILITY_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { line: { type: "string" }, missing: { type: "string" }, possible: { type: "boolean" } },
        required: ["line", "missing", "possible"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

/**
 * The ability list for a chat kind (`"one"` or `"group"`): each capability's line for that kind (skipped where its
 * field is null), then a `can't` line for each can't that holds everywhere or in that kind of chat.
 */
export function abilityList(kind) {
  const group = kind === "group";
  const where = group ? "group" : "1:1";
  const lines = [];
  for (const entry of CAPABILITIES) {
    const text = group ? entry.group : entry.texts;
    if (text !== null && text !== undefined) lines.push(`- ${entry.name}: ${text}`);
  }
  for (const entry of CAPABILITIES) {
    for (const cant of entry.cant ?? []) {
      if (cant.where === "everywhere" || cant.where === where) lines.push(`- can't: ${cant.what}`);
    }
  }
  return lines.join("\n");
}

/** The Messages API body for one vote on one row's must lines. `gold` is the gold reply's texts, for reference. */
export function abilityBody({ model, kind, ask, must, gold, vote }) {
  const content = [
    "Decide each must line below, against the abilities listed.",
    `vote: ${vote}`,
    `Chat: ${kind === "group" ? "a group chat" : "a 1:1 text"}`,
    "",
    "Abilities:",
    abilityList(kind),
    "",
    "The person's ask:",
    "<ask>",
    String(ask ?? ""),
    "</ask>",
    "",
    "The gold reply's texts, for reference only (what Tex did say):",
    "<gold_reply>",
    JSON.stringify(gold),
    "</gold_reply>",
    "",
    "The must lines, in order:",
    "<must_lines>",
    JSON.stringify(must),
    "</must_lines>",
  ].join("\n");
  return JSON.stringify({
    model,
    max_tokens: ABILITY_MAX_TOKENS,
    system: ABILITY_SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: ABILITY_SCHEMA } },
  });
}

/** True for a request this check sent (its system prompt), never for a judge request. */
export function isAbilityBody(body) {
  try {
    return String(JSON.parse(body).system ?? "").startsWith(ABILITY_OPENING);
  } catch {
    return false;
  }
}

/**
 * A scripted reply for `--fake` and the tests: every must line is possible. Plumbing only; it reads the must lines the
 * request carries and answers each one.
 */
export function fakeAbilityReply(body) {
  const content = JSON.parse(body).messages[0].content;
  const must = JSON.parse(content.slice(content.indexOf("<must_lines>") + 12, content.indexOf("</must_lines>")));
  const reply = { content: [{ type: "text", text: JSON.stringify({ lines: must.map((line) => ({ line, missing: "", possible: true })) }) }] };
  return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** One vote's per-line answers, asked again when the reply is not usable. */
async function voteOf(send, body, must) {
  let problem = "no reply";
  for (let attempt = 1; attempt <= ABILITY_ATTEMPTS; attempt += 1) {
    const response = await send(body);
    if (!response.ok) throw new Error(`ability check call failed: status ${response.status}`);
    const reply = await response.json();
    const text = (reply.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    try {
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const lines = parsed?.lines;
      if (!Array.isArray(lines)) throw new Error("no lines");
      if (lines.length !== must.length) throw new Error(`${lines.length} lines for ${must.length} must lines`);
      if (lines.some((entry) => typeof entry?.possible !== "boolean")) throw new Error("a line has no possible: true or false");
      return lines.map((entry) => ({ possible: entry.possible, missing: String(entry.missing ?? "") }));
    } catch (error) {
      problem = error.message;
    }
  }
  throw new Error(`ability check reply is not usable (${problem}) after ${ABILITY_ATTEMPTS} attempts`);
}

/**
 * The must lines that BOTH votes call impossible, by index, as `{ line, missing }` in the order of the must lines. A row
 * with none is not impossible. No must lines, no calls.
 */
export async function impossibleLines(send, { model, kind, ask, must, gold }) {
  if (must.length === 0) return [];
  const votes = await Promise.all(ABILITY_VOTES.map((vote) => voteOf(send, abilityBody({ model, kind, ask, must, gold, vote }), must)));
  return must.flatMap((line, k) => {
    if (!votes.every((vote) => !vote[k].possible)) return [];
    const missing = votes.map((vote) => vote[k].missing).find((text) => text !== "") ?? "an ability no listed one gives";
    return [{ line, missing }];
  });
}

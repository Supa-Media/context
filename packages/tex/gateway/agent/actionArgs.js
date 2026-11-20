/**
 * An action's arguments, checked against its own schema before it runs.
 *
 * WHY (Dev2, 2026-11-20: "the way to treat actions better with the validated schema ... we just need to get this down
 * pat"). The six tools are fixed so the prompt cache reads them, and each one's JSON schema says only `action: string,
 * args: object`: an action's own arguments were text on its line and in its manual, and nothing held a call to them.
 * The gateway's actions were checked only once they reached the gateway, and Tex's own (browse, open_page, job_status
 * and the rest, `ASSISTANT_SEND_ACTIONS`) not at all: a key one of them does not take was dropped unseen, and a wrong
 * type reached the tool's own code to fail there in its own words, or not at all.
 *
 * Every action already has one schema, its carrier's `inputSchema`: the line on the tool list (`actionArguments`) and
 * the manual (`fetch manual:<action>`) are both written from it. Here the call is held to the same schema, at one
 * place, for every action, before anything runs: an unknown key, a missing required one, a wrong type, a value outside
 * its enum or bounds is refused naming that argument and what it takes, and `manualOnFailure` sends the manual with it.
 * The schema is read as closed here even where the carrier leaves it open, so a key the action does not take is said,
 * never silently dropped. The tool list itself does not change by a byte.
 *
 * One reading is taken rather than refused, the slip seen most (send email, `to` as one string, 7 of 19 failed emails,
 * 7 days to 2026-11-20): a lone string where the schema takes a list of strings becomes a list of one, when it has no
 * comma or semicolon that would make it several, and so does one written under the list's name in the singular (`url`
 * for open_page's `urls`). A number or yes/no written as text, where the schema takes one, is read
 * as it, as the gateway already reads an `args` sent as JSON text (`coercedArguments`).
 */

import { validateArguments } from "../../../../apps/mcp/src/tools/advertised.js";

/** What the call itself carries beside the action's own arguments: routing reads these, every action takes them. */
const ADDRESSING = ["context", "mailbox", "person_said"];

/** The schema as this check reads it: closed at the top, the addressing keys allowed beside the action's own. */
function closed(schema) {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, property]) => [key, shallow(property)]));
  for (const key of ADDRESSING) if (!Object.hasOwn(properties, key)) properties[key] = { type: "string" };
  return { ...schema, type: "object", properties, additionalProperties: false };
}

/**
 * A property as this check reads it: its own type, bounds and enum, but never the fields of an object inside it, alone
 * or in a list. Those are the tool's own to judge, in its own words: browse reads a step's `ref` written "3" or "[3]"
 * as 3, and names the step to use for one that is not a step ("opening an address is a goto step"); held to the
 * schema, those calls were refused in the schema's words instead (production, 2026-11-20 21:xxZ).
 */
function shallow(property) {
  if (!property || typeof property !== "object") return property;
  const { properties, required, additionalProperties, ...own } = property;
  if (property.type === "array" && property.items?.type === "object") return { ...own, items: { type: "object" } };
  return property.type === "object" ? own : property;
}

/** Whether a property's schema takes a list of strings. */
const takesStrings = (property) => property?.type === "array" && (!property.items || property.items.type === "string");

/** The one reading of a value written in the wrong shape, or the value as it came. */
function oneReading(property, value) {
  if (typeof value !== "string" || !property) return value;
  if (takesStrings(property)) return /[,;]/.test(value) || value.trim() === "" ? value : [value.trim()];
  if (property.type === "integer" && /^-?\d{1,15}$/.test(value.trim())) return Number(value.trim());
  if (property.type === "number" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  if (property.type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

/**
 * `{ args }` to run the action with, or `{ error }`: the action's arguments held to its carrier's schema. Keys whose
 * value is undefined are dropped first: the gateway's translation writes every field it may carry.
 */
export function checkActionArguments(schema, args) {
  const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  if (!schema || typeof schema !== "object" || schema.type !== undefined && schema.type !== "object") return { args: given };
  // A schema that names nothing and closes nothing describes no arguments to hold a call to (the advisor reads the whole
  // turn, and a question sent with it does no harm), so the call goes as it came.
  if (schema.additionalProperties !== false && Object.keys(schema.properties ?? {}).length === 0) return { args: given };
  const properties = schema.properties ?? {};
  const read = {};
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined) continue;
    // One of a list, under the list's own name in the singular (`url` for `urls`, `title` for `titles`): that list.
    const plural = `${key}s`;
    if (!Object.hasOwn(properties, key) && takesStrings(properties[plural]) && given[plural] === undefined && typeof value === "string") {
      read[plural] = oneReading(properties[plural], value);
      continue;
    }
    read[key] = oneReading(properties[key], value);
  }
  const refusal = validateArguments(closed(schema), read);
  return refusal === null ? { args: read } : { error: refusal };
}

/** The refusal Tex reads, in the call's own words: which action, what is wrong, and that nothing ran. */
export function actionArgumentsRefusal(family, action, why) {
  return `${family} ${action}: ${why}. Nothing ran: call it again with the args its manual gives.`;
}

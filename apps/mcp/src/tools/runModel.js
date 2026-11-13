/**
 * `run_model` (`manage` action `run_model`): one Workers AI model run for the
 * Architecture Lab, whose Tex runs on the Claude subscription and answers
 * every Claude call by hand. The models it names (Clef and GLM, both on
 * Workers AI) are not Claude, so the Lab must call them for real. The session
 * holds no Cloudflare key and keys never live in notes, so the gateway runs
 * them with its own binding (decided by the owner, 2026-11-13: "non-Claude
 * steps must run as real API calls"; keys never in notes).
 *
 * Staff only: the session's person must be an owner or an editor of
 * `@context-lc`, the people who edit the AI setup (`editsPinnedContext`). It
 * is never offered to Tex (`WITHHELD_TOOLS`), and it changes nothing and needs
 * no one's yes. Its model call uses the same binding and, for these models,
 * the same no-options call the product's own Workers AI calls make
 * (`decide.js`, `builtin.js`), so it is metered and logged like Tex's own.
 * The input and the output are never logged.
 */

import { editsPinnedContext } from "../context/identity.js";
import { toolError, toolText } from "./results.js";

/** The only models a Lab run may name: Clef and GLM, both on Workers AI. */
export const LAB_MODELS = Object.freeze(["@cf/cloudflare/clef", "@cf/zai-org/glm-4.7-flash"]);

/** The largest `input`, as JSON text, that one run may send. */
export const MAX_INPUT_CHARS = 64_000;

/** The one sentence a person who does not edit `@context-lc` is answered with (also `session.js`'s gate). */
export const RUN_MODEL_WHO = "run_model is for people who edit @context-lc's AI setup.";
const NO_BINDING = "Workers AI is not set up on this deployment.";

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Run `args.model` on `ai` with `args.input`. Every refusal is an isError
 * answer, and so is a model that throws: nothing here throws.
 *
 * @param {{ ai: any, session: object, workspace: string, args: object, now?: () => number }} call
 */
export async function runLabModel({ ai, session, workspace, args, now = Date.now }) {
  if (!editsPinnedContext(session)) return toolError(RUN_MODEL_WHO);
  const model = args?.model;
  if (typeof model !== "string" || !LAB_MODELS.includes(model)) {
    return toolError(`run_model takes one model: ${LAB_MODELS.join(" or ")}.`);
  }
  const input = args?.input;
  if (!isPlainObject(input)) return toolError("run_model takes input as one JSON object.");
  let inputText;
  try {
    inputText = JSON.stringify(input);
  } catch {
    return toolError("run_model's input is not JSON.");
  }
  if (inputText.length > MAX_INPUT_CHARS) {
    return toolError(`run_model's input is over ${MAX_INPUT_CHARS} characters of JSON; send less.`);
  }
  if (typeof ai?.run !== "function") return toolError(NO_BINDING);

  const started = now();
  let ok = false;
  try {
    const output = await ai.run(model, input);
    const text = JSON.stringify(output ?? null);
    ok = true;
    return toolText(text);
  } catch (error) {
    return toolError(typeof error?.message === "string" && error.message !== "" ? error.message : "The model could not answer just now.");
  } finally {
    console.log(JSON.stringify({ event: "lab_model_run", model, workspace, ms: now() - started, ok }));
  }
}

/**
 * The dispatcher's case: the store carries the call's own session and binding
 * (`attachLinkCalls`). A store without one is not a pinned-workspace session,
 * so it is refused with the same sentence a member gets.
 */
export function toolRunModel(store, args) {
  if (typeof store?.runLabModel !== "function") return toolError(RUN_MODEL_WHO);
  return store.runLabModel(args);
}

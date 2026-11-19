/**
 * The router node, `router` (texConfig.json, group "tools-subagents", off in main's config): beside the Door, Clef picks the
 * specialist door a text's turn goes through (`../../specialistRoute.js`, `../../doorTurn.js`). Wires: `doorStep ->
 * router` (uses; a check-in or a routine skips the Door and stays on today's front door), and `router -> handoff` (uses) when a long job should go to the Hand-off node at once.
 *
 * Input: the text, whether it came in a group, what started the turn, the Shape gate's read when it had one, and the
 * chat's last lines before the text (`recent`, oldest first) when the history was read in time.
 * Output: `{ route, sure, when }` with route quick, read, act, job, or "none" when there is no model here, the call
 * failed or ran out of time, or it named no route. Never throws.
 */
import { decisionEngine } from "../../decide.js";
import { readRoute, routeRequest } from "../../specialistRoute.js";
import { texTimeoutMs } from "../../texConfig.js";

/** The longest the router may take when its config names no limit: Clef answers in about half a second. */
const DEFAULT_MS = 2_500;

export async function routerNode(input, io) {
  const t = io?.ctx?.turn ?? {};
  const engine = io?.engine ?? decisionEngine(t.env?.AI);
  if (typeof engine !== "function" || typeof input?.question !== "string" || input.question.trim() === "") return { route: "none" };
  const asked = routeRequest({ question: input.question, group: input.group === true, trigger: input.trigger, shape: input.shape ?? null, recent: Array.isArray(input.recent) ? input.recent : [] });
  let limit = DEFAULT_MS;
  try {
    limit = texTimeoutMs("router");
  } catch {
    // a config with no limit for it: the default
  }
  let timer;
  const answers = await Promise.race([
    Promise.resolve().then(() => engine(asked.state, asked.questions)).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), limit);
    }),
  ]).finally(() => clearTimeout(timer));
  const read = readRoute(answers);
  return read === null ? { route: "none" } : { route: read.route, sure: read.sure, when: [read.route] };
}

/**
 * The chaos line on a tool's answer (`docs/decisions/chaos-score.md`, "Every write answers with the change"), moved
 * out of `tools/session.js`, which calls it after every dispatched tool.
 */

import { normalizePath } from "../notes/paths.js";
import { ANSWER_WAIT_MS, CHAOS_TOOLS, chaosLines, takeChaos, withChaosLines, within } from "./report.js";
import { changeChaos } from "./change.js";

/**
 * End a write's answer with what it did to the chaos score (`chaos/report.js`).
 *
 * The count was started by the change itself (`chaos/change.js`); a save of
 * an existing note's text starts none (the editor saves on every pause), so
 * for `write_note` one is started here, for that note alone, which counts its
 * new length against the facts' old one. Never throws, and never holds
 * an answer longer than `ANSWER_WAIT_MS`.
 */
export async function reportingChaos(store, name, args, scope, result) {
  const started = takeChaos(store);
  if (!CHAOS_TOOLS.has(name) || !result || result.isError) return result;
  // A comment or a website action changes no folder.
  if (args?.comment !== undefined || args?.site !== undefined) return result;
  try {
    let report = started === undefined ? null : await within(started, ANSWER_WAIT_MS);
    if (started === undefined && name === "write_note" && typeof args?.path === "string") {
      const path = normalizePath(args.path);
      if (path) report = await within(changeChaos(store, { files: [path] }), ANSWER_WAIT_MS);
    }
    return withChaosLines(result, chaosLines(report, scope === "private" ? "all" : "team"));
  } catch {
    return result;
  }
}

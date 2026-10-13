/**
 * The chaos score at the top of `orient`: the number, and the few places
 * that would calm it most, so an agent knows the workspace's shape before it
 * writes. It reports and never asks the agent to tidy: tidying is for when a
 * person asks (the owner, 2026-10-10).
 */

import { canSee } from "../privacy/engine.js";
import { treeClientOf } from "../tree/record.js";
import { chaosOn, chaosReady, chaosSummary } from "./table.js";
import { chaosExtras, liveSummary, scoreKeys } from "./live.js";
import { chaosWord } from "./rubric.js";
import { within } from "./report.js";

/** How the score is counted, in one paragraph an agent can follow. */
export const CHAOS_RULES =
  "How it is counted: a folder is calm at 4 to 5 items, 10 is average, and 35 or more is full chaos; " +
  "under 4 is thin (a folder with only its about note is the worst). A run of numbered or dated notes " +
  "counts as one item per 30. A note past 1,000 lines adds chaos, meetings excepted. Archive is not " +
  "counted. Every write and move answers with what it did to the score.";

/**
 * The orient section, or null when the score is not kept here yet.
 *
 * @param {object} store
 * @param {string} scope the connection's scope; anything but `private` reads the team numbers
 */
export async function chaosSection(store, scope, rules, overrides) {
  const client = treeClientOf(store);
  if (client === null) return null;
  const audience = scope === "private" ? "all" : "team";
  const visible = (path) => canSee(path, scope, rules, overrides);
  const summary = await within(
    liveSection(store, client, audience, visible, rules, overrides).then(
      (live) => live ?? chaosSummary(client, { audience, limit: 4, visible }),
    ),
    2500,
  );
  if (!summary) return null;
  const score = Math.round(summary.score);
  const was = summary.weekAgo === null ? "" : `; a week ago ${Math.round(summary.weekAgo)}`;
  const lines = [`## Chaos score\n\nChaos ${score} of 100 (${chaosWord(summary.score)}, lower is calmer${was}).`];
  if (summary.folders.length > 0) {
    lines.push(
      "Biggest wins:\n" +
        summary.folders
          .map((entry) => `- ${entry.folder === "" ? "(top level)" : entry.folder}: ${entry.items} items, chaos ${Math.round(entry.chaos)}`)
          .join("\n"),
    );
  }
  if (summary.longNotes.length > 0) {
    lines.push("Long notes:\n" + summary.longNotes.map((note) => `- ${note.path}: ${note.lines.toLocaleString("en-US")} lines`).join("\n"));
  }
  lines.push(CHAOS_RULES);
  return lines.join("\n\n");
}

/**
 * The summary counted from the Convex tree's keys (`live.js`) where this call
 * is served from it (`tree/served.js`), or null when it is not and the
 * table's numbers answer. The keys are the grant's; the team numbers count
 * only what the team may open, so an owner and a member are told what the
 * table would tell them.
 */
export async function liveSection(store, client, audience, visible, rules, overrides) {
  if (typeof store.treeKeys !== "function") return null;
  try {
    if (!(await chaosReady(client))) return null;
    const [keys, extras] = await Promise.all([store.treeKeys(), chaosExtras(client)]);
    if (keys === null) return null;
    const folders = scoreKeys(keys, extras, (path) => canSee(path, "team", rules, overrides));
    const weekAgo = await chaosOn(client, 7, audience);
    return liveSummary(folders, extras, { team: audience === "team", present: new Set(keys), visible, limit: 4, weekAgo });
  } catch {
    return null;
  }
}

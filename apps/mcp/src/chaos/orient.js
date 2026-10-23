/**
 * The chaos score at the top of `orient`: the number, and the few places
 * that would calm it most, so an agent knows the workspace's shape before it
 * writes. It reports and never asks the agent to tidy: tidying is for when a
 * person asks (the owner, 2026-10-10).
 */

import { canSee } from "../privacy/engine.js";
import { liveSummary, liveTotals, scoreKeys } from "./live.js";
import { factChaos } from "../tree/facts.js";
import { chaosWord } from "./rubric.js";
import { within } from "./report.js";

/** How the score is counted, in one paragraph an agent can follow. */
export const CHAOS_RULES =
  "How it is counted: a folder is calm at 4 to 5 items, 10 is average, and 35 or more is full chaos; " +
  "under 4 is thin (a folder with only its about note is the worst). A run of numbered or dated notes " +
  "counts as one item per 30. A note past 1,000 lines adds chaos, meetings excepted. Archive is not " +
  "counted. Every write and move answers with what it did to the score.";

/**
 * The orient section, or null where the Convex tree does not serve this call
 * or its facts cannot answer: the search database's score table that answered
 * before was retired in phase 7 (`tree/retired.js`).
 *
 * @param {object} store
 * @param {string} scope the connection's scope; anything but `private` reads the team numbers
 */
export async function chaosSection(store, scope, rules, overrides) {
  const audience = scope === "private" ? "all" : "team";
  const visible = (path) => canSee(path, scope, rules, overrides);
  const summary = await within(factSection(store, audience, visible, rules, overrides), 2500);
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
 * The summary counted from the Convex tree's keys, with what the keys cannot
 * say from its facts (`tree/facts.js`), or null where either cannot answer.
 * An owner reading privately counts both audiences, so their read keeps
 * today's score for "a week ago" later.
 */
export async function factSection(store, audience, visible, rules, overrides) {
  if (typeof store.treeKeys !== "function" || typeof store.treeFacts !== "function") return null;
  try {
    const keys = await store.treeKeys();
    if (keys === null) return null;
    const facts = await factChaos(store);
    if (facts === null) return null;
    const extras = facts.extras;
    const folders = scoreKeys(keys, extras, (path) => canSee(path, "team", rules, overrides));
    if (audience === "all") {
      const keep = () => factChaos(store, liveTotals(folders)).catch(() => null);
      if (typeof store.defer === "function") store.defer(keep);
      else void keep();
    }
    return liveSummary(folders, extras, { team: audience === "team", present: new Set(keys), visible, limit: 4, weekAgo: facts.weekAgo });
  } catch {
    return null;
  }
}

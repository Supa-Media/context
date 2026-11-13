/**
 * THE LIVE PROMPT'S WATCH (Dev2, 2026-11-13). The gateway reads `@context-lc ai/production/` on every turn: each
 * job's setup and the prompt modules under `ai/production/prompt/`. A change there is live the moment it is saved,
 * through no pull request and no replay gate. AI Promote is the one gated way in (`promote.mjs`: it writes the job's
 * file with a `promoted_by` line naming the promotion gate); a hand edit, or an edit to a prompt module, is not.
 *
 * The nightly fingerprints every production note and holds it against the last scoreboard's: what changed since,
 * and whether AI Promote did it. The nightly's own runs then measure the changed prompt, so a hand edit is scored
 * within a day, and the scoreboard names it beside any area that fell.
 */
import { createHash } from "node:crypto";

import { callTool, notePaths, PRODUCTION_FOLDER, splitNote } from "./context.mjs";
import { frontMatter } from "./resultNote.mjs";

const version = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 12);

/** Each production note's version: `[{ path, version, promotedOn }]`, `promotedOn` the date AI Promote wrote it. */
export function fingerprint(notes) {
  return notes
    .map(({ path, content }) => {
      const by = String(frontMatter(content).promoted_by ?? "");
      const promotedOn = /promotion gate/.test(by) ? (/(\d{4}-\d{2}-\d{2})/.exec(by)?.[1] ?? null) : null;
      return { path, version: version(content), promotedOn };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The fingerprint table a scoreboard keeps, read back: path -> version. */
export function readFingerprint(scoreboard) {
  const out = new Map();
  let inTable = false;
  for (const line of String(scoreboard ?? "").split("\n")) {
    if (/^\| note \| version \|/.test(line)) inTable = true;
    else if (inTable && /^\| ---/.test(line)) continue;
    else if (inTable) {
      const m = /^\| `([^`]+)` \| `([0-9a-f]{12})` \|/.exec(line);
      if (!m) break;
      out.set(m[1], m[2]);
    }
  }
  return out;
}

/**
 * What changed since the last scoreboard (written on `since`): `[{ path, change: "changed" | "added" | "removed",
 * how: "AI Promote" | "outside the gate" }]`. A change is AI Promote's when the note says the gate wrote it on or
 * after `since`; everything else, a prompt module included, came in outside the gate.
 */
export function changesSince(now, before, since) {
  if (before.size === 0) return [];
  const out = [];
  for (const note of now) {
    const was = before.get(note.path);
    if (was === note.version) continue;
    const how = note.promotedOn && since && note.promotedOn >= since ? "AI Promote" : "outside the gate";
    out.push({ path: note.path, change: was ? "changed" : "added", how });
  }
  for (const path of before.keys()) if (!now.some((note) => note.path === path)) out.push({ path, change: "removed", how: "outside the gate" });
  return out;
}

/** The scoreboard's section: the fingerprint, and what changed since the last night. */
export function productionLines({ now, changes, since }) {
  const lines = ["## The live prompt", ""];
  if (since === null) lines.push("No earlier scoreboard to hold it against: tonight's fingerprint is the first.", "");
  else if (changes.length === 0) lines.push(`Unchanged since the scoreboard of ${since}.`, "");
  else {
    const outside = changes.filter((change) => change.how === "outside the gate");
    lines.push(
      outside.length
        ? `⚠️ ${outside.length} production note(s) changed since ${since} outside the gate: live at once, with no replay. Tonight's runs measured them; an area that fell beside one of these is the first place to look, and AI Promote's revert puts a job's file back.`
        : `Changed since ${since}, all through AI Promote.`,
      "",
      ...changes.map((change) => `- \`${change.path}\` ${change.change}, ${change.how}`),
      "",
    );
  }
  lines.push("| note | version |", "| --- | --- |", ...now.map((note) => `| \`${note.path}\` | \`${note.version}\` |`), "");
  return lines;
}

/** Every production note, read from Context: `[{ path, content }]`. */
export async function readProduction(connection, fetchImpl = fetch) {
  const listed = await callTool(connection, "list_notes", { prefix: PRODUCTION_FOLDER }, fetchImpl);
  if (listed.isError) throw new Error(`list_notes ${PRODUCTION_FOLDER}: ${listed.text}`);
  const notes = [];
  for (const path of notePaths(listed.text).filter((p) => !p.endsWith("/about.md"))) {
    const read = await callTool(connection, "read_note", { path }, fetchImpl);
    if (!read.isError) notes.push({ path, content: splitNote(read.text).content });
  }
  return notes;
}

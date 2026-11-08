/**
 * TEX'S OWN JOBS, SWITCHED OFF BY THE PERSON (Dev2, 2026-11-08: "add an off
 * switch for each that works from a text").
 *
 * Housekeeping (`housekeeping.js`) and the overnight memory pass, the dream
 * (`dream.js`), are on by default. Each has a settings note in the person's
 * own `tex/` folder, beside the folder of its logs, as the check-in has
 * `tex/heartbeat.md`: `paused: yes` in its front matter switches it off,
 * `paused: no` (or no note) leaves it on. Tex writes the note when they ask
 * ("Tex, stop tidying my notes"), and it is a note like any other, so they
 * can edit it in the app too.
 */

import { readWithEtag } from "./jobLog.js";

/** Switches off Tex's daily tidy of their workspace. */
export const HOUSEKEEPING_SETTINGS_PATH = "tex/housekeeping.md";
/** Switches off the nightly rewrite of About me; the summaries of their days still run. */
export const DREAMS_SETTINGS_PATH = "tex/dreams.md";

/** Whether a settings note's front matter says `paused: yes` (or true, on). A note without front matter is on. */
export function switchedOff(text) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---" || line.trim() === "...") return false;
    const match = /^\s*paused\s*:\s*(.+?)\s*$/i.exec(line);
    if (match) return /^(true|yes|on)$/i.test(match[1].replace(/^["']|["']$/g, ""));
  }
  return false;
}

/** Whether the person switched the job whose settings note is `path` off. A note that can't be read leaves it on. */
export async function isSwitchedOff(dispatch, path) {
  const read = await readWithEtag(dispatch, path).catch(() => null);
  return switchedOff(read?.body ?? "");
}

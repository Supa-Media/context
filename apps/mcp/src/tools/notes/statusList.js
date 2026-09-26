/**
 * A folder's status list, as an agent is told it: which statuses a folder
 * offers in each group, and a note after a write whose `status` is not one of
 * them. The list and its meaning are `lists/statuses.js`; this only reads the
 * front notes it lives in, through the caller's own clearance.
 *
 * A front note the caller cannot see is passed over exactly as the app's own
 * device copy passes it over (it never holds it), so the answer an agent gets
 * is the one the board it shares with a person draws, and it discloses
 * nothing about a note held back. An encrypted front note has no readable
 * frontmatter and is passed over too.
 */

import { canSee } from "../../privacy/engine.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { isEncryptedNote } from "../../encryption.js";
import { FRONT_NOTES } from "../../lists/grammar.js";
import { noteProperties } from "../../lists/properties.js";
import {
  STATUS_GROUPS,
  STATUS_GROUP_LABELS,
  declaresStatuses,
  defaultStatusList,
  isDeclaredStatus,
  statusGroupOf,
  statusListOf,
} from "../../lists/statuses.js";

/** The list governing `folder`: `{ list, from }`, `from` null for the defaults. */
export async function readStatusList(store, scope, rules, overrides, folder) {
  let at = String(folder || "").replace(/^\/+|\/+$/g, "");
  while (at !== "") {
    for (const name of FRONT_NOTES) {
      const path = `${at}/${name}`;
      if (!canSee(path, scope, rules, overrides)) continue;
      const object = await getWithLegacyFallback(store, path);
      if (!object) continue;
      const text = await object.text();
      if (isEncryptedNote(text)) break;
      const properties = noteProperties(text);
      if (declaresStatuses(properties)) return { list: statusListOf(properties), from: at };
      break; // the first front note present speaks for the folder
    }
    at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
  }
  return { list: defaultStatusList(), from: null };
}

/** "Not started: No status, exploration · In progress: in progress · Done: finished" */
export function describeStatusList(list) {
  return STATUS_GROUPS.map((group) => {
    const words = group === "not-started" ? ["No status", ...list[group]] : list[group];
    return `${STATUS_GROUP_LABELS[group]}: ${words.join(", ")}`;
  }).join(" · ");
}

/**
 * The folder whose list describes a note's status: a front note's status is
 * its folder's, which its parent's list describes.
 */
export function governingFolderOf(path) {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  if (FRONT_NOTES.includes(name)) parts.pop();
  return parts.join("/");
}

/**
 * A line for `write_note` when the note's `status` is not one of its folder's
 * statuses, or null when it is (or it has none). Advice, never a refusal:
 * the file is the person's, and the board asks them which group it is in.
 */
export async function statusAdvice(store, scope, rules, overrides, path, content) {
  const raw = noteProperties(content).status;
  const status = typeof raw === "string" ? raw.trim() : Array.isArray(raw) ? String(raw[0] ?? "").trim() : "";
  if (status === "") return null;
  const folder = governingFolderOf(path);
  const { list, from } = await readStatusList(store, scope, rules, overrides, folder);
  if (isDeclaredStatus(status, list)) return null;
  const group = statusGroupOf(status, list);
  const where = from === null ? "this folder (the defaults)" : `${from}/`;
  const reads = group === null ? "It is in no group yet, so the board will ask which group it belongs to." : `It reads as ${STATUS_GROUP_LABELS[group]}.`;
  return `status: "${status}" is not one of the statuses for ${where} — ${describeStatusList(list)}. ${reads} Prefer one of those words.`;
}

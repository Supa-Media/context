/**
 * A GROUP CHAT'S LEARNED SKILLS, `skills/` IN ITS HOME, AS A PERSON'S TEX KEEPS `tex/skills/` (the owner, 2026-11-01:
 * "1:1 tex folders and group tex folders ... i would like them to mirror"; 2026-11-02 on what a group may learn from:
 * "as long as it's inside the texts from people in that group, then it's fine ... it's almost like they give combined
 * consent"; `docs/decisions/texting-assistant/tex-folders.md`).
 *
 * The same notes, by the same rules (`learnedSkills.js`: name, front matter, size, at most 40, never vouched for),
 * in `<home>/skills/`. A group turn is always marked as having taken in other people's words, which is what keeps its
 * sends held (`texEntryPoint.js`); the people in the chat are not outside it, so what stops a skill being written here is a
 * turn that read something from outside the chat this turn (a page, an email, a file: `ledger.outside`).
 *
 * Read through the home's own dispatcher only; written by the model with `context: "@context-lc"` at the home's path.
 */

import { listSkillNames, learnedSkillSession, readLearnedSkills, READ_LEARNED_SKILL_TOOL, SKILL_READS, skillWriteRefusal } from "./learnedSkills.js";
import { toolError } from "../tools/results.js";

/** Where a home keeps its skills. */
export function chatSkillsFolder(home) {
  return `${home.folder}/skills`;
}

const segmentsOf = (path) =>
  String(path ?? "")
    .trim()
    .replace(/^(?:\.\/|\/)+/, "")
    .replace(/^@[^/]*\/+/, "")
    .toLowerCase()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

/**
 * Whether `path` is the home's skills folder or under it, however it is cased or spaced, compared by segment for the
 * reason `touchesSkills` is: the store normalizes the string after this guard has read it.
 */
export function touchesChatSkills(home, path) {
  if (!home || typeof path !== "string") return false;
  const folder = segmentsOf(chatSkillsFolder(home));
  const given = segmentsOf(path);
  return given.length >= folder.length && folder.every((segment, at) => given[at] === segment);
}

/** The path as the store will hold it: leading slashes, a workspace in front, and empty or `.` segments dropped. */
const storedPath = (path) =>
  String(path ?? "")
    .trim()
    .replace(/^(?:\.\/|\/)+/, "")
    .replace(/^@[^/]*\/+/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

/** Every string in `value` but a note's content, at any depth. */
function stringsIn(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, found);
  else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) if (key !== "content") stringsIn(inner, found);
  return found;
}

/** The chat's skills, read from its home, or null for a turn with no home. Never throws. */
export async function openChatSkills(group) {
  const home = group?.home;
  if (!home) return null;
  const folder = chatSkillsFolder(home);
  try {
    return learnedSkillSession(await readLearnedSkills(home.dispatch, folder), home.dispatch, { folder, whose: `this chat's folder, ${folder}/` });
  } catch {
    return learnedSkillSession([], home.dispatch, { folder });
  }
}

/**
 * `callTool` with the chat's `read_learned_skill` answered here, and every call naming the home's `skills/` checked:
 * refused once the turn read something from outside the chat (`outside()`); otherwise only `write_note` passes, held to
 * `skillWriteRefusal` in the home's folder. Without a home, `callTool` as it is.
 */
export function withChatSkills(group, learned, callTool, { outside }) {
  const home = group?.home;
  if (!home) return callTool;
  const folder = chatSkillsFolder(home);
  return async (name, args) => {
    if (name === READ_LEARNED_SKILL_TOOL && learned !== null) return await learned.call(args);
    if (SKILL_READS.has(name)) return await callTool(name, args);
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (!stringsIn(given).some((value) => touchesChatSkills(home, value))) return await callTool(name, args);
    if (outside()) {
      return toolError("This turn read something from outside this chat, so it can't write or change a skill. Nothing was changed.");
    }
    // No archive: a note archived out of a home would leave its seal (`chat-homes.md`), and a group moves nothing.
    if (name !== "write_note") return toolError(`A skill is changed only by writing its whole note at ${folder}/<name>.md. Nothing was changed.`);
    const refusal = skillWriteRefusal(storedPath(given.path), given.content, await listSkillNames(home.dispatch, folder), folder);
    if (refusal !== null) return toolError(`${refusal} Nothing was written.`);
    return await callTool(name, args);
  };
}

/** What a turn in a chat with a home is told about its skills, after its jobs (`chatHome.js` `homePrompt`). */
export function chatSkillsPrompt(group) {
  const home = group?.home;
  if (!home) return "";
  return (
    `\nSkills. After a hard job here (many steps, or one you got right only after a wrong turn), write how you did it as ${chatSkillsFolder(home)}/<name>.md ` +
    `(context: "@context-lc"), as a person's Tex keeps tex/skills/: front matter name, when (one line) and updated (today), then the steps that worked. `
  );
}

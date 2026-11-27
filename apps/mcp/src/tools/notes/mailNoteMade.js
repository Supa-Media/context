/**
 * An area's or a bot's mail note, made when it is missing (Dev, 2026-11-27: "fix these PLEASE", after three of
 * Capabilities' routine answers came back NOT_FOUND because `<area>/mail/capabilities.md` had never been made, so the
 * bot answered somewhere the card doesn't count).
 *
 * A bot is told to answer its routines in `<area>/mail/<its name>.md` (`areaRoutines.cjs` `routinesText`). Nothing made
 * that note, so the first answer had nowhere to go. Now:
 *
 *   - the first mail write (or join) to a missing `<folder>/mail/<name>.md` makes it, when `<folder>/about.md` is
 *     there: an area's settings or a bot's card. A path under any other folder stays "not found", so a typo never
 *     makes a mail folder somewhere new;
 *   - `manage area` making a bot an area's owner or delegate makes the bot's note there at once (`setArea.js`).
 *
 * The note is made through `toolWriteNote` like any save, so the caller needs write access to the folder, and its
 * visibility is the folder's. An existing note is never touched.
 */

import areaBots from "../../../../../packages/shared/src/areaBots.cjs";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";

const { mailJoinName } = areaBots;

/** `<folder>/mail/<name>.md` → `{folder, name}`, or null for any other path. */
export function mailNoteParts(path) {
  const match = typeof path === "string" ? /^(.+)\/mail\/([^/]+)\.md$/.exec(path) : null;
  return match === null ? null : { folder: match[1], name: match[2] };
}

const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");

/** "areas/tex-devs" → "Tex devs": the folder's own name, as a title. */
function titleOf(folder, title) {
  const said = typeof title === "string" ? title.trim().replace(/^["']|["']$/g, "") : "";
  if (said !== "") return said;
  const word = folder.slice(folder.lastIndexOf("/") + 1).replace(/[-_]+/g, " ").trim();
  return word === "" ? folder : word[0].toUpperCase() + word.slice(1);
}

/**
 * Makes `path` when it is a missing mail note beside an `about.md`. Answers `"made"`, `"there"` (it already was),
 * `"not_mail"` (no mail note of an area or a bot: leave the caller's own "not found"), or an error's text.
 */
export async function makeMailNote(store, scope, rules, overrides, path) {
  const parts = mailNoteParts(path);
  if (parts === null || mailJoinName(parts.name) !== parts.name.toLowerCase()) return "not_mail";
  const about = `${parts.folder}/about.md`;
  // Read, not the facts: they may not have caught up with a card or an area made a moment ago.
  const settings = await toolReadNote(store, scope, rules, overrides, about);
  if (settings?.isError) return "not_mail";
  const read = await toolReadNote(store, scope, rules, overrides, path);
  if (!read?.isError) return "there";
  if (!/not found/i.test(textOf(read))) return textOf(read);
  const title = titleOf(parts.folder, /^title:\s*(.+)$/m.exec(textOf(settings))?.[1]);
  const written = await toolWriteNote(store, scope, rules, overrides, { path, content: `# Mail with ${title}\n`, summary: "made this mail note" }, { mailOwn: true, mustCreate: true });
  if (!written?.isError) return "made";
  // Two first writes at once: the other made it.
  const again = await toolReadNote(store, scope, rules, overrides, path);
  return again?.isError ? textOf(written) : "there";
}

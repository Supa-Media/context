/**
 * A group chat that reads only its own home: one whose people don't all share a workspace (the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/group-guests.md`, `docs/decisions/texting-assistant/chat-homes.md`).
 *
 * Since 2026-11-25 (Dev2: "there shouldnt be any capability split between the two") such a chat is no separate mode:
 * it gets the same prompt and tools as every group (`groupTurn.js` `groupPrompt`, `groupWriteTools`). What differs is
 * only what it may read, and that is the grant's, before this module runs: its home-only grant names say it reads as
 * the chat (`READS_AS_CHAT`), and its rules are read for the chat alone, so a row the chat holds is `team` and every
 * other row `private` (`apps/convex/functions/lib/nodes/chatFolders.ts`). It is known from those names, never from
 * anything the Worker sends. Its home is the one folder it may change (the session's `chatHome`, `chatHome.js`).
 *
 * What this module holds, as privacy and never as capability:
 *
 *  - **Notes**: written and moved within what the chat reads, never a row it holds only to view
 *    (`store/readOnlyRows.js`), never published, shared, sent to a site or a mailbox, and never in another context.
 *  - **Who sees what**: no visibility, encryption, link, layout or invite change from here (`HOME_ONLY_REFUSED`).
 *  - **Email and calendar**: from someone with no account, they go only from the account of someone here who has
 *    one, on that person's own yes (`as`, `tools/offerFor.js`); their yes settles nothing.
 */

import { loadPrivacyState } from "../../../../apps/mcp/src/privacy/state.js";
import { canSee, readsAsChat } from "../../../../apps/mcp/src/privacy/engine.js";
import { toolError } from "../../../../apps/mcp/src/tools/results.js";
import { guestNameOf, numberOf } from "./groupNames.js";

/** Whether this session reads only its chat's home, by the names its grant holds (its home-only grant reads as the chat). */
export function isHomeOnlyChat(session) {
  return readsAsChat(session?.grantedGroups);
}

/**
 * Who keeps the chat from a shared workspace, as the Worker passed the control plane's answer on: a handle or a guest's
 * label and why, never a number. It only names; what the chat may read is the grant's (`groupTurn.js` `reachOf`), never this.
 */
const BLOCKED_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const BLOCKED_WHO = /^(?:[a-z0-9][a-z0-9-]{0,64}|guest-[0-9a-f]{4})$/;
export function blockedOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 24)
    .filter((entry) => entry !== null && typeof entry === "object" && BLOCKED_SLUG.test(entry.slug ?? "") && BLOCKED_WHO.test(entry.who ?? "") && (entry.why === "not_member" || entry.why === "no_account"))
    .map(({ slug, who, why }) => ({ slug, who, why }));
}

/**
 * Who here can't open a shared workspace of the asker's (`apps/convex/functions/lib/textGroupBlockers.ts`; Dev2,
 * 2026-11-16: the Crystal Care chat lost its workspace overnight when someone joined who isn't a member; 2026-11-25:
 * a turn reads the asker's own workspaces, `docs/decisions/texting-assistant/asker-reach.md`). Facts only (Dev2,
 * 2026-11-25: "hard coding responses to a model goes against the point"): who is missing, and, for a workspace this
 * turn can't read, what lets a chat in. What to say, and when, is the model's judgment, taught by Training
 * conversations. Someone without an account is named as the chat knows them, a kept name or their number, never by a
 * guest label (Dev2, 2026-11-25: Tex called someone "guest-e792" though it knew the number). "" when nothing is missing.
 */
export function blockedLine(group) {
  const blocked = Array.isArray(group?.blocked) ? group.blocked : [];
  if (blocked.length === 0) return "";
  const reach = new Set(Array.isArray(group?.reach) ? group.reach : []);
  const bySlug = new Map();
  for (const { slug, who, why } of blocked) {
    const named = why === "no_account" ? `${knownAs(group, who)} (not on Context, not invited)` : `@${who} (not a member)`;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), named]);
  }
  const line = (slugs) => slugs.map((slug) => `@${slug} is missing ${bySlug.get(slug).join(", ")}`).join("; ");
  const read = [...bySlug.keys()].filter((slug) => reach.has(slug));
  const kept = [...bySlug.keys()].filter((slug) => !reach.has(slug));
  return (
    (read.length > 0 ? `Not everyone here can open ${read.map((slug) => `@${slug}`).join(", ")}: ${line(read)}. ` : "") +
    (kept.length > 0
      ? `This chat can't use ${kept.map((slug) => `@${slug}`).join(", ")}: ${line(kept)}. ` +
        "A chat reaches a workspace when everyone in it is a member or invited by number; an owner of it can have you invite them (send chat_add_everyone). "
      : "")
  );
}

/** Someone without an account as this chat knows them: their kept name, else their number, never their label. */
function knownAs(group, label) {
  const name = guestNameOf(group, label);
  const number = numberOf(group, label);
  if (name) return number ? `${name}, ${number}` : name;
  return number ? `the ${number} number` : "someone here";
}

/**
 * What Tex is told about its own texts in a group (bot battle, 2026-11-23): asked for the chat's latest message it
 * named the asker's and left out its own three replies, and it said "No" to "can you reply threaded?" while its
 * reply went threaded (`send.js` places every reply under the text it answers).
 */
export const GROUP_SELF_LINE =
  "Your own texts are messages in this chat like anyone's: when someone asks what was said last or who said what, count yours. " +
  "Your answer goes under the text it answers, as an iMessage threaded reply; when that text was itself a reply, iMessage shows yours in that same thread. ";

/** Whether anyone here has no Context account (`groupTurn.js` `groupOf`: everyone else here by label). */
export function hasGuests(group) {
  return Array.isArray(group?.guests) && group.guests.length > 0;
}

/**
 * What a chat that reads only its home is told it may read and write, in place of a shared workspace's lines
 * (`groupTurn.js` `groupPrompt`, the one prompt every group gets). `group.home` is the chat's home, or null.
 */
export function homeOnlyLines(group, workspace) {
  const where = workspace ? `@${workspace}` : "one workspace";
  const folder = group.home ? `${group.home.folder}/` : "this chat's folder";
  return (
    `You can read only what is shared with this chat in ${where}: its folder ${folder} and whatever someone shared with the chat. ` +
    "Nothing else there exists for you, so never guess at it; someone can share a note with the chat for you to read. " +
    `Write what you make for the chat in ${folder}, as a page (<name>.page.md) like any new note: pages save here like anywhere else, ` +
    "so if a page write is refused, read the refusal, fix what it names and write the page again; never tell the chat pages can't be saved from here, and never save a plain note instead. " +
    "A note shared with the chat to view can be read, never changed. " +
    "You can't publish, share or change who sees anything from here. "
  );
}

/** Where an email or calendar change goes from when someone here has no account to send it from; "" when all do. */
export function noAccountSendLine(group) {
  if (!hasGuests(group) && group?.guestTagger !== true) return "";
  const members = Array.isArray(group?.people) && group.people.length > 0 ? group.people.map((handle) => `@${handle}`).join(", ") : "nobody";
  return (
    `Someone here who isn't on Context has no account to send from: what they ask for goes from the account of someone here who is (${members}), ` +
    "so pass as with that person's handle; only that person's 👍 or yes makes it. "
  );
}

/**
 * What a chat that reads only its home never does, whoever asks: each publishes, shares, changes who sees something or
 * reaches a workspace it isn't in. Every other tool is a group's like any other's; the grant decides what it reads.
 */
export const HOME_ONLY_REFUSED = Object.freeze([
  "set_visibility", "set_folder_visibility", "set_encryption", "rotate_encryption_keys", "create_link", "revoke_link",
  "vault_share_link", "invite_member", "apply_layout", "migrate_storage_layout",
]);

/** A note write's arguments such a chat never passes: each publishes, shares, mails or reaches another context. */
const WIDER = ["site", "mail", "mailbox", "share", "share_short", "visibility", "confirm_team_publish", "context", "source_context", "destination_context"];

/** The note tools whose paths are checked against what the chat holds to view only, and whose moves must stay inside it. */
const NOTE_TOOLS = Object.freeze(["write_note", "move_note", "move_notes", "move_folder", "archive_note"]);

/** Every note path a note tool's arguments name, and the ones a move would put a note at. */
function notePaths(name, args) {
  const moves = name === "move_notes" && Array.isArray(args.moves) ? args.moves : [];
  const from = [args.path, args.source, args.folder, ...moves.map((move) => move?.source)];
  const to = [args.destination, ...moves.map((move) => move?.destination)];
  const strings = (list) => list.filter((value) => typeof value === "string" && value !== "");
  return { all: strings([...from, ...to]), to: name === "write_note" || name === "archive_note" ? [] : strings(to) };
}

/**
 * The dispatcher a chat that reads only its home calls through, in front of a group's (`groupAwareCallTool`): the
 * refusals above, each said in words the model can act on. `guestTagger` is whether someone with no account, not a member, tagged Tex.
 */
export function homeOnlyCallTool(callTool, { store, group, guestTagger }) {
  const readOnly = (path) => typeof store?.readOnlyAt === "function" && store.readOnlyAt(path);
  return async (name, args) => {
    const supplied = args ?? {};
    if (HOME_ONLY_REFUSED.includes(name)) return toolError(`${name} can't be used from this chat: it reads only its own folder, and nothing is published, shared or made visible to more people from here. Say in a line that its owner can do it by texting you on their own.`);
    if (NOTE_TOOLS.includes(name)) {
      const wider = WIDER.find((key) => supplied[key] !== undefined);
      if (wider) return toolError(`${name} can't pass ${wider} from this chat: it only keeps notes inside what the chat reads.`);
      const paths = notePaths(name, supplied);
      const held = paths.all.find((path) => readOnly(path));
      if (held) return toolError(`${held} is shared with this chat to view only, so it can't be changed from here.`);
      for (const destination of paths.to) {
        if (!(await chatReads(store, destination))) return toolError(`Not moved: ${destination} is outside what this chat can read, and a note moved there would leave the chat.`);
      }
    }
    if ((name === "send_email" || name === "calendar_event") && guestTagger && supplied.as === undefined) {
      const members = group.people.map((handle) => `@${handle}`).join(", ");
      return toolError(
        members
          ? `Not done: someone here who isn't on Context asked, so it goes from the account of someone here who is on Context. Make the same call with as naming one of ${members}; only their yes sends it.`
          : "Not done: nobody in this chat is on Context with an account it could go from. Say so in a line.",
      );
    }
    const result = await callTool(name, supplied);
    return name === "write_note" ? hiddenNameRefusal(result, supplied.path, group) : result;
  };
}

/**
 * A write in the chat's own home refused as outside what it may write. The home is held at edit, so the one thing
 * that refuses there is a note under that name the chat can't see: one a member saved, which the chat's rules read as
 * private (`chatRules` in the control plane). On 2026-10-28 Tex, asked for a page, chose the name of a page a member had
 * already saved there, read "permission denied", and told the chat it couldn't write pages to its own folder. It is
 * told to use another name instead, in words that say nothing about what is there.
 */
function hiddenNameRefusal(result, path, group) {
  const folder = group?.home?.folder;
  if (result?.isError !== true || typeof path !== "string" || !folder || !path.startsWith(`${folder}/`)) return result;
  const text = Array.isArray(result.content) ? result.content.map((part) => part?.text ?? "").join("") : "";
  if (!text.startsWith("permission denied:")) return result;
  return toolError(`That name can't be written from this chat. Save it under a different name in ${folder}/ and send that link; nothing else needs to change.`);
}

/** Whether the chat reads `path`, by its store's rules (which are the chat's own). */
async function chatReads(store, path) {
  try {
    const { rules, overrides, error } = await loadPrivacyState(store);
    return !error && canSee(path, "team", rules, overrides, null);
  } catch {
    return false;
  }
}

/**
 * What the "Read the text" node logs of a group chat's workspaces, every group turn (Dev2, 2026-11-16): the ones it
 * reaches, and who keeps it from the rest, so Replay shows why a chat can't see one. Nothing for a 1:1 text.
 */
export function groupReachOut(group) {
  if (group === null || group === undefined) return {};
  const reach = Array.isArray(group.reach) ? group.reach.map((slug) => `@${slug}`).join(", ") : "";
  const blocked = (Array.isArray(group.blocked) ? group.blocked : []).map(({ slug, who, why }) => `${why === "no_account" ? who : `@${who}`} ${why === "no_account" ? "has no account" : "not in"} @${slug}`).join("; ");
  return { reach: reach || "none", ...(blocked ? { blocked } : {}) };
}

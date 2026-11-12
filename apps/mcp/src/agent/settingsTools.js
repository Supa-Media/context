/**
 * TEX'S OWN SETTINGS, READ AND CHANGED FROM A TEXT (Dev2, 2026-11-12: "make sure that tex is privy to its settings
 * configuration and the user can make changes in the chat without having to open the UI";
 * `docs/decisions/texting-assistant/settings-by-text.md`).
 *
 * Every setting is one row of `packages/shared/src/texSettings.cjs`. This module is how a texted turn reads them all
 * (`settingsSnapshot`, appended to `send tex_settings`) and changes the ones that aren't already another tool's:
 *
 *  - `send setting` (`tex_setting_set`): check-ins, quiet hours, texts from their other AIs, the overnight About me
 *    rewrite and the daily tidy, each a front matter key of a settings note in their own `tex/` folder, the same keys
 *    the Tex page's switches write (`http/texPage/notes.js`). A person's own chat only: they are theirs.
 *  - `send vault_access` (`vault_access`): who each saved login is for, and changing it: give it to this chat, the
 *    whole workspace or a person by @handle, take it back, keep it to themselves, or cut every AI off it. The control
 *    plane takes the person off the turn's own grant (a group chat's only on the tagger's own tag) and lets only
 *    whoever saved a login change it (`functions/vaultByText.ts`); Dev2 chose "on the saver's own words", so a widening
 *    runs only when the turn's own message asks for it (`consentFor`, the judge every widening uses). Values never
 *    pass through here.
 */

import { readAttentionSettings, TOLERANCES } from "./attention.js";
import { readQuietHours } from "./quietHours.js";
import { DREAMS_SETTINGS_PATH, HOUSEKEEPING_SETTINGS_PATH } from "./texSwitches.js";
import { frontSet, readCheckinSettings, readSwitches } from "../http/texPage/notes.js";
import { contextsFor } from "../context/identity.js";
import { FLAGS } from "../../../../packages/shared/src/flags.cjs";
import { TEX_SETTINGS } from "../../../../packages/shared/src/texSettings.cjs";

const HEARTBEAT_PATH = "tex/heartbeat.md";
const ATTENTION_PATH = "tex/attention.md";

function text(words, isError = false) {
  return { content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) };
}

/** Read one note's front matter through the turn's own tool door, or null. */
async function readFront(dispatch, path) {
  try {
    const result = await dispatch("read_note", { path });
    if (result?.isError === true) return "";
    const all = (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
    const split = all.indexOf("\n\n");
    return split === -1 ? "" : all.slice(split + 2);
  } catch {
    return null;
  }
}

const onOff = (value) => (value === true || /^(on|yes|true)$/i.test(String(value ?? "").trim()) ? true : value === false || /^(off|no|false)$/i.test(String(value ?? "").trim()) ? false : null);

/**
 * The `setting` action's switches, by `texSettings.cjs` key: each reads `value` and changes one note's front matter,
 * or answers why not. `apps/mcp/test/texSettings.test.mjs` holds these keys equal to the registry's `via: "setting"` rows.
 */
export const SETTING_HANDLERS = Object.freeze({
  checkins: { values: "on or off", set: (call, value) => (onOff(value) === null ? null : frontSet(call, HEARTBEAT_PATH, "paused", onOff(value) ? "no" : "yes")), said: (value) => `check-ins are ${onOff(value) ? "on" : "off"}` },
  quiet_hours: {
    values: "a window like \"11 pm to 7 am\", or off",
    set: (call, value) => {
      const words = String(value ?? "").trim();
      if (/^(off|none|no|clear)$/i.test(words)) return frontSet(call, HEARTBEAT_PATH, "quiet-hours", null);
      return readQuietHours(words) === null ? null : frontSet(call, HEARTBEAT_PATH, "quiet-hours", words);
    },
    said: (value) => (/^(off|none|no|clear)$/i.test(String(value).trim()) ? "quiet hours are off" : `quiet hours are ${value}`),
  },
  pings: {
    values: "strict, relaxed, emergencies or off",
    set: async (call, value) => {
      const words = String(value ?? "").trim().toLowerCase().replace(/ only$/, "");
      if (words === "off") return frontSet(call, ATTENTION_PATH, "paused", "yes");
      if (!TOLERANCES.includes(words)) return null;
      const paused = await frontSet(call, ATTENTION_PATH, "paused", null);
      return paused?.ok === true ? frontSet(call, ATTENTION_PATH, "tolerance", words) : paused;
    },
    said: (value) => `texts from their other AIs are ${String(value).toLowerCase()}`,
  },
  overnight: { values: "on or off", set: (call, value) => (onOff(value) === null ? null : frontSet(call, DREAMS_SETTINGS_PATH, "paused", onOff(value) ? "no" : "yes")), said: (value) => `the overnight About me rewrite is ${onOff(value) ? "on" : "off"}` },
  tidy: { values: "on or off", set: (call, value) => (onOff(value) === null ? null : frontSet(call, HOUSEKEEPING_SETTINGS_PATH, "paused", onOff(value) ? "no" : "yes")), said: (value) => `the daily tidy of their notes is ${onOff(value) ? "on" : "off"}` },
});

const SETTING_KEYS = Object.keys(SETTING_HANDLERS);

/** One login as a line: who has it and whether it works here. Never a value. */
function loginLine(entry) {
  const who = entry.who?.length ? entry.who.join(", ") : entry.yours ? "only them" : `given to them by ${entry.savedBy}`;
  const here = entry.here === undefined ? "" : entry.here ? "; works in this chat" : "; not usable in this chat";
  const ais = entry.ais?.length ? `; AIs allowed: ${entry.ais.join(", ")}` : "";
  return `- ${entry.name} (${entry.type}${entry.sites?.length ? ` on ${entry.sites.join(", ")}` : ""}, id ${entry.entry}): ${who}${here}${ais}${entry.yours ? "" : " (saved by someone else, so only they change who has it)"}`;
}

/**
 * Everything set for this chat beyond the instructions `send tex_settings` already reads: in their own chat, every
 * switch, their workspaces and features; in a group, the workspaces it reaches; and in both, the saved logins and who
 * has each. Lines for the turn to answer from; anything unreadable is said to be unknown, never guessed.
 */
export async function settingsSnapshot({ session, controlPlane, group, dispatch }) {
  const lines = [];
  if (group === null && typeof dispatch === "function") {
    const [checkins, switches, attention] = await Promise.all([
      readCheckinSettings(dispatch).catch(() => null),
      readSwitches(dispatch).catch(() => null),
      readFront(dispatch, ATTENTION_PATH),
    ]);
    if (checkins) lines.push(`Check-ins: ${checkins.paused ? "off" : "on"}; quiet hours: ${checkins.quietHours ?? "none"}.`);
    if (attention !== null) {
      const said = readAttentionSettings(attention);
      lines.push(`Texts from their other AIs: ${said.paused ? "off" : said.tolerance}${said.mute.length ? `; muted words: ${said.mute.join(", ")}` : ""}.`);
    }
    if (switches) lines.push(`Overnight About me rewrite: ${switches.dreams ? "on" : "off"}. Daily tidy of their notes: ${switches.housekeeping ? "on" : "off"}.`);
    const flags = (Array.isArray(session?.flags) ? session.flags : []).filter((id) => Object.hasOwn(FLAGS, id)).map((id) => FLAGS[id].label);
    lines.push(`Features turned on early for them: ${flags.length ? flags.join(", ") : "none"}.`);
  }
  const workspaces = contextsFor(session ?? {}).map((entry) => `${entry.name} (${entry.kind === "personal" ? "personal" : entry.role}${entry.current ? ", this chat's default" : ""})`);
  if (workspaces.length) lines.push(`Workspaces ${group === null ? "they" : "this chat"} can reach: ${workspaces.join(", ")}.`);
  const vault = typeof controlPlane?.vaultText === "function" ? await listAll(session, controlPlane) : null;
  if (vault !== null) lines.push(vault === "none" ? "Saved logins, keys and cards: none they can use." : `Saved logins, keys and cards (send vault_access changes who has one):\n${vault}`);
  const changeable = TEX_SETTINGS.filter((row) => row.where.includes(group === null ? "1:1" : "group"));
  lines.push(
    `What can be changed by text: ${changeable.filter((row) => row.byText).map((row) => row.label).join(", ")}. Only in the app: ${changeable.filter((row) => !row.byText).map((row) => `${row.label} (${row.appPath})`).join("; ")}.`,
  );
  return lines.join("\n");
}

/** The workspaces whose vaults a texted turn may list and change: the chat's own first, then each other one they edit. */
function vaultWorkspaces(session) {
  const rows = (Array.isArray(session?.workspaces) ? session.workspaces : []).filter((row) => typeof row?.workspaceId === "string" && typeof row.slug === "string" && (row.role === "owner" || row.role === "editor"));
  const first = rows.find((row) => row.workspaceId === session?.workspaceId);
  return [...(first ? [first] : []), ...rows.filter((row) => row !== first)].slice(0, MAX_VAULTS);
}
const MAX_VAULTS = 6;

/** Every login they can use across those workspaces, each line under its workspace; null when none could be read. */
async function listAll(session, controlPlane) {
  const read = await Promise.all(
    vaultWorkspaces(session).map(async (row) => ({ row, answer: await controlPlane.vaultText(session.accessToken, row.workspaceId, { op: "list" }).catch(() => null) })),
  );
  const done = read.filter(({ answer }) => answer?.status === "done");
  if (done.length === 0) return null;
  const parts = done.filter(({ answer }) => answer.entries.length > 0).map(({ row, answer }) => `In @${row.slug}:\n${answer.entries.map(loginLine).join("\n")}`);
  return parts.length ? parts.join("\n") : "none";
}

const VAULT_REFUSALS = {
  refused: "Not from here: only the person who tagged you, on their own tag, or the person in their own chat, can change a login, in a workspace they can edit. Nothing was changed.",
  not_found: "There's no such login among the ones they can use. Read the list first (do list). Nothing was changed.",
  not_yours: "Only the person who saved that login can change who has it. Nothing was changed; say who saved it.",
  no_chat: "\"this chat\" works only in a group chat. Nothing was changed.",
  personal: "A login in a personal workspace stays theirs: to give it to people, they save it in a shared workspace (manage vault_add with that context). Nothing was changed.",
  not_member: "That person isn't a member of this workspace, so it can't be given to them. Nothing was changed; offer to invite them first.",
  bad_request: "Name who: \"chat\", \"workspace\" or their @handle. Nothing was changed.",
};

/** The words a widening needs in the turn's own message before the judge is asked (`commandTools.js` `consentFor`). */
const VAULT_WORDS = /\b(shar\w*|give|let|access|use|everyone|everybody|workspace|team|chat|group|\w+@|@\w+|login|password|key|card|vault)\b/i;

/**
 * `send setting` and `send vault_access` for a texted turn. `consent(kind)` is the turn's own-words check
 * (`consentForTurn`), asked only before a widening.
 */
export function settingsTools({ session, controlPlane, group, dispatch, words = "", judge = null }) {
  const tools = [];
  if (group === null && typeof dispatch === "function") {
    tools.push({
      tool: {
        name: "tex_setting_set",
        description:
          "Change one of their own Tex settings when they ask, then say in a line what it is now. setting: " +
          SETTING_KEYS.map((key) => `${key} (${SETTING_HANDLERS[key].values})`).join(", ") +
          ". How you talk is send tex_instructions, sharing their chats with the team is send review_sharing, computers are send computers.",
        inputSchema: { type: "object", properties: { setting: { type: "string", enum: SETTING_KEYS }, value: { type: "string" } }, required: ["setting", "value"] },
      },
      call: async (args) => {
        const handler = Object.hasOwn(SETTING_HANDLERS, args?.setting) ? SETTING_HANDLERS[args.setting] : null;
        if (handler === null) return text(`setting is one of: ${SETTING_KEYS.join(", ")}. Nothing was changed.`, true);
        const done = await Promise.resolve(handler.set(dispatch, args.value)).catch(() => ({ ok: false }));
        if (done === null) return text(`For ${args.setting} the value is ${handler.values}. Nothing was changed.`, true);
        return done?.ok === true ? text(`Saved: ${handler.said(args.value)}. Tell them in a line.`) : text("That couldn't be saved right now. Nothing was changed; say so plainly.", true);
      },
    });
  }
  if (typeof controlPlane?.vaultText === "function" && group?.guestTagger !== true) {
    const asked = async () => {
      const said = typeof words === "string" ? words : "";
      if (!VAULT_WORDS.test(said)) return false;
      if (typeof judge !== "function") return true;
      try {
        return (await judge({ words: said, action: "let more people (or a group chat) use one of the person's saved logins, keys or cards through their AIs" }))?.allow === true;
      } catch {
        return false;
      }
    };
    tools.push({
      tool: {
        name: "vault_access",
        description:
          "Who can use each saved login, key or card, and changing it. do: list (every one they can use, who has it, whether it works here); " +
          "share (entry, to: \"chat\" for this group chat, \"workspace\" for everyone in it, or a member's @handle), only when they ask in their own words; " +
          "unshare (entry, from: the same); only_me (entry: take it back from everyone); cut_off (entry: stop every AI using it until they allow one again in the app). " +
          "Only whoever saved a login changes who has it. People given one use it through their AIs and never see the password. Say back who has it now.",
        inputSchema: {
          type: "object",
          properties: {
            do: { type: "string", enum: ["list", "share", "unshare", "only_me", "cut_off"] },
            entry: { type: "string" },
            to: { type: "string" },
            from: { type: "string" },
            context: { type: "string", description: "The workspace the login is saved in, as @name, from do list; leave it out for this chat's own." },
          },
          required: ["do"],
        },
      },
      call: async (args) => {
        const op = args?.do;
        if (!["list", "share", "unshare", "only_me", "cut_off"].includes(op)) return text("do is list, share, unshare, only_me or cut_off. Nothing was changed.", true);
        if (op !== "list" && typeof args?.entry !== "string") return text("Pass entry, a login's id from do list. Nothing was changed.", true);
        if (op === "share" && !(await asked())) return text("They have to ask for that in their own words. Nothing was changed; tell them so.", true);
        if (op === "list") {
          const all = await listAll(session, controlPlane);
          if (all === null) return text(VAULT_REFUSALS.refused, true);
          return text(all === "none" ? "Nothing saved that they can use. manage vault_add gives them a link to save one." : all);
        }
        const slug = typeof args?.context === "string" ? args.context.trim().replace(/^@/, "").toLowerCase() : "";
        const where = slug === "" ? vaultWorkspaces(session)[0] : vaultWorkspaces(session).find((row) => row.slug === slug);
        if (!where) return text(`${slug ? `@${slug} isn't a workspace they edit` : "There's no workspace here they edit"}. Nothing was changed.`, true);
        const request = { op, entry: args.entry, ...(op === "share" ? { to: args.to } : {}), ...(op === "unshare" ? { from: args.from } : {}) };
        const answer = await controlPlane.vaultText(session.accessToken, where.workspaceId, request).catch(() => null);
        if (answer?.status !== "done") return text(VAULT_REFUSALS[answer?.status] ?? "That couldn't be done right now. Nothing was changed; say so plainly.", true);
        return text(`Done. Now, in @${where.slug}: ${loginLine(answer.entry)}`);
      },
    });
  }
  return tools;
}

export { SETTINGS_SEND_ACTIONS } from "./settingsActions.js";

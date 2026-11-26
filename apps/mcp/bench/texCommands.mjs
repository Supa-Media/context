/**
 * TEX'S CHAT COMMANDS IN THE BENCH'S WORLD (`/gateway/tex/command`, the control plane's `functions/texCommands.ts`).
 *
 * How Tex talks in a chat, its mute, its status and its shared mail are rows the control plane keeps, changed by the
 * settings tools a turn is given (`src/agent/commandTools.js`). The bench's control plane never learnt the route, so
 * "less emojis from now on" ended in "That couldn't be done right now" on every run, a failure production would not
 * give, and the judge graded Tex on it (Training, 2026-11-18). This is that route for one conversation's chat: the same
 * commands, the same statuses, the instructions changed by the control plane's own rules
 * (`lib/texInstructions.ts` applyInstructionsChange), kept in memory for the conversation.
 *
 * It decides no access: who may run a command in which chat is the control plane's check on a live grant, proven in
 * its own tests. Here the one person or group of the conversation asks, and is allowed.
 */

/** The longest the instructions may be (`lib/texInstructions.ts` MAX_INSTRUCTIONS). */
export const MAX_INSTRUCTIONS = 1_500;
const UPDATES = ["off", "planOnly", "normal"];
const ENGAGEMENT = ["off", "quiet", "attentive", "followAlong", "helpful"];

const tidy = (text) => String(text).split("\n").map((line) => line.trim()).filter(Boolean).join("\n");

/** One change to the kept instructions: what is kept now, or `{ refused }`. */
export function applyChange(kept, command) {
  const now = kept.instructions ?? "";
  const text = typeof command.text === "string" ? command.text : "";
  if (text.length > MAX_INSTRUCTIONS) return { refused: "bad_request" };
  if (command.action === "undo") {
    if (kept.instructionsBefore === undefined) return { refused: "nothing_to_undo" };
    return kept.instructionsBefore === "" ? {} : { instructions: kept.instructionsBefore };
  }
  let next;
  if (command.action === "clear") next = "";
  else if (text.trim() === "") return { refused: "bad_request" };
  else if (command.action === "add") next = `${now}\n${text}`;
  else if (command.action === "remove") next = now.split("\n").filter((line) => line.trim() !== tidy(text)).join("\n");
  else if (command.action === "replace") next = text;
  else return { refused: "bad_request" };
  const saved = tidy(next);
  if (saved.length > MAX_INSTRUCTIONS) return { refused: "too_long" };
  if (saved === now) return { ...(saved !== "" ? { instructions: saved } : {}), ...(kept.instructionsBefore !== undefined ? { instructionsBefore: kept.instructionsBefore } : {}) };
  return { ...(saved !== "" ? { instructions: saved } : {}), instructionsBefore: now };
}

/**
 * One chat's commands. `group` is the chat's shared workspace name, or null for a person's own chat; `setBy` the
 * handle a group's change is said with. `answer(command)` is the route's body; `changes()` what was changed, in order.
 */
export function createTexCommands({ group = null, setBy = "someone here" } = {}) {
  let kept = {};
  const state = { muted: false, updates: undefined, engagement: undefined, sharing: false, mail: [] };
  const changes = [];
  const settings = () => ({ ...(kept.instructions ? { instructions: kept.instructions } : {}), ...(state.updates ? { updates: state.updates } : {}) });
  return {
    changes: () => [...changes],
    /** The mail shared with this chat, as the Worker names it on every later turn (`group.mail`). */
    mail: () => state.mail.map((row) => ({ ...row })),
    answer(command) {
      const kind = command?.kind;
      if (kind === "settings") {
        return group === null
          ? { status: "done", ...settings(), sharing: state.sharing }
          : { status: "done", ...settings(), ...(state.engagement ? { engagement: state.engagement } : {}), engagementChosen: state.engagement !== undefined, slug: group, ...(state.mail.length ? { mail: state.mail } : {}) };
      }
      if (kind === "instructions") {
        const result = applyChange(kept, command);
        if (result.refused) return { status: result.refused };
        kept = result;
        changes.push(`how Tex talks here is now: ${kept.instructions ? JSON.stringify(kept.instructions) : "nothing set"}`);
        return { status: "done", ...settings(), ...(group !== null ? { setBy } : {}) };
      }
      if (kind === "updates") {
        if (!UPDATES.includes(command.updates)) return { status: "bad_request" };
        state.updates = command.updates;
        changes.push(`progress updates: ${command.updates}`);
        return { status: "done", ...settings(), ...(group !== null ? { setBy } : {}) };
      }
      if (kind === "review_sharing") {
        if (group !== null || typeof command.share !== "boolean") return { status: group !== null ? "not_allowed" : "bad_request" };
        state.sharing = command.share;
        changes.push(`sharing finished chats with the team: ${command.share ? "on" : "off"}`);
        return { status: "done", sharing: state.sharing };
      }
      // The rest are a group chat's own.
      if (group === null) return { status: "not_allowed" };
      if (kind === "mute") {
        state.muted = true;
        changes.push("Tex muted in this chat");
        return { status: "done", muted: true };
      }
      if (kind === "status") return { status: "done", slug: group, guest: false };
      if (kind === "engagement") {
        if (!ENGAGEMENT.includes(command.engagement)) return { status: "bad_request" };
        state.engagement = command.engagement;
        changes.push(`when Tex speaks up: ${command.engagement}`);
        return { status: "done", engagement: command.engagement };
      }
      if (kind === "share_mail") {
        const address = String(command.address ?? "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { status: "mail_refused" };
        state.mail = [...state.mail.filter((row) => row.address !== address), { handle: setBy, address }];
        changes.push(`mail shared with this chat: ${address}`);
        return { status: "done", address };
      }
      if (kind === "unshare_mail") {
        const address = command.address === undefined ? null : String(command.address).trim().toLowerCase();
        const before = state.mail.length;
        state.mail = address === null ? [] : state.mail.filter((row) => row.address !== address);
        if (before !== state.mail.length) changes.push("mail no longer shared with this chat");
        return { status: "done", count: before - state.mail.length };
      }
      return { status: "bad_request" };
    },
  };
}

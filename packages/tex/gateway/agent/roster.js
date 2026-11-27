/**
 * Who holds each area and which bots work there, in each workspace a person reaches, told to their 1:1 turns (Dev,
 * 2026-11-27: "Tex is a little oblivious to the new bots, area charter flow, and mailing flow"; Tex was asked to send
 * a folder to a bot and had to search for it, then wrote the work itself instead of mailing the bot).
 *
 * The words are `orient { about: "roster" }`'s, one call per workspace through the person's own dispatch, so a turn is
 * told exactly what any connected agent is told, read by the same rules: only about.md notes and bot cards the person
 * can see. Facts as data; what to do with them is taught by Training conversations, never by words here
 * (`docs/decisions/texting-assistant/no-scripted-wording.md`).
 */

/** The workspaces read, at most; a person in more gets the first ones, their own and the shared ones they write in. */
export const MAX_ROSTER_WORKSPACES = 8;
/** What one workspace's roster keeps, and the whole module. */
export const ROSTER_WORKSPACE_CHARS = 2_500;
export const ROSTER_CHARS = 8_000;
/** The longest one workspace's read may take before the turn goes on without it. */
const ROSTER_READ_MS = 1_500;

/** Which of the person's workspaces are read: those they may write in, theirs first. */
export function rosterWorkspaces(contexts) {
  const list = (Array.isArray(contexts) ? contexts : []).filter((entry) => typeof entry?.name === "string" && entry.name !== "" && entry.canWrite !== false && entry.askerOwn !== true);
  return [...list.filter((entry) => entry.current), ...list.filter((entry) => !entry.current)].slice(0, MAX_ROSTER_WORKSPACES);
}

const textOf = (result) =>
  result && result.isError !== true && Array.isArray(result.content)
    ? result.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim()
    : "";

/** A roster that names nothing: no area with an owner and no bot card. */
const isEmpty = (text) => text === "" || (/^No area here names an owner yet\./.test(text) && /None this connection can see\./.test(text));

const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/**
 * Each workspace's roster, `[{ name, text }]`, leaving out a workspace with no areas or bots, or one whose read failed
 * or ran long. Never throws.
 *
 * @param {(name: string, args: object) => Promise<object>} dispatch the person's own tool dispatch
 * @param {Array<{name: string, current?: boolean, canWrite?: boolean}>} contexts the session's workspaces
 */
export async function readRoster(dispatch, contexts) {
  if (typeof dispatch !== "function") return [];
  const reads = rosterWorkspaces(contexts).map(async (entry) => {
    try {
      const result = await within(dispatch("orient", { context: entry.name, about: "roster" }), ROSTER_READ_MS);
      const text = textOf(result);
      return isEmpty(text) ? null : { name: entry.name, text: text.slice(0, ROSTER_WORKSPACE_CHARS) };
    } catch {
      return null;
    }
  });
  return (await Promise.all(reads)).filter(Boolean);
}

/** The module's words: each workspace's roster under its name, or "" when none names an area or a bot. */
export function rosterPrompt(roster) {
  if (!Array.isArray(roster) || roster.length === 0) return "";
  const body = roster.map(({ name, text }) => `In ${name}:\n${text}`).join("\n\n");
  return `\n\nBots and areas:\n\n${body.slice(0, ROSTER_CHARS)}`;
}

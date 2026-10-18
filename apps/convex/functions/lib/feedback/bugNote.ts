/**
 * A bug report filed by texting Tex, as the note it becomes in the pinned
 * context (decided by the owner, 2026-10-18;
 * `docs/decisions/texting-assistant/bug-reports.md`).
 *
 * Pure: where the note goes and what it says. `bugNotes.ts` decides whether
 * there is anywhere to put it and writes it.
 *
 * The folder is split by who filed it: `team/` for somebody with a real
 * membership in the pinned context, `user/` for everybody else, who reaches
 * it only through the pin. The texts are the person's, attached only after
 * their YES to the exact report (`apps/mcp/src/tools/reportGate.js`), and go
 * in a fenced block, as the message does, so nothing in either renders.
 */

/** Under the pinned context's Areas folder, or `areas/` where it has none. */
export const BUG_FOLDER = "tex-bugs";
/** Where the Areas job has no folder, the name the owner asked for. */
export const DEFAULT_AREAS_FOLDER = "areas";
/** Words of the message in the note's name, so a listing says what each is. */
const NAME_WORDS = 8;

export interface BugNoteInput {
  message: string;
  texts?: string;
  /** Their handle, without the `@`, or null for an account that has none. */
  handle: string | null;
  team: boolean;
  /** The report's reference, as the person was told it. */
  eventId: string;
  now: number;
}

/** The folder doing the Areas job, or `areas` when none does. */
export function bugFolder(areas: string | null, team: boolean): string {
  const root = (areas ?? DEFAULT_AREAS_FOLDER).replace(/^\/+|\/+$/g, "");
  return `${root === "" ? DEFAULT_AREAS_FOLDER : root}/${BUG_FOLDER}/${team ? "team" : "user"}`;
}

/** `2026-10-18 1342 search found nothing for a note abc123.md`: sorts by time, says what, never collides. */
export function bugNotePath(folder: string, input: Pick<BugNoteInput, "message" | "eventId" | "now">): string {
  const stamp = new Date(input.now).toISOString();
  const words = input.message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "")
    .slice(0, NAME_WORDS)
    .join(" ");
  const name = `${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)} ${words === "" ? "bug" : words} ${input.eventId.slice(0, 6)}`;
  return `${folder}/${name}.md`;
}

/** A fence longer than any run of backticks in `text`, so the text cannot close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** One line, for a title: the message's first line, bounded. */
function titleOf(message: string): string {
  const first = message.split("\n").find((line) => line.trim() !== "")?.trim() ?? "Bug report";
  // Plain words only: a heading renders, so nothing in it may be a link or an image.
  const chars = [...first.replace(/[#`*_[\]()!<>|\\]/g, " ").replace(/\s+/g, " ").trim()];
  if (chars.length === 0) return "Bug report";
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : chars.join("");
}

export function renderBugNote(input: BugNoteInput): string {
  const lines = [
    "---",
    "status: open",
    "source: texts",
    `filed: ${new Date(input.now).toISOString()}`,
    `from: ${JSON.stringify(input.handle === null ? "an account with no handle" : `@${input.handle}`)}`,
    `reporter: ${input.team ? "team" : "user"}`,
    `reference: ${JSON.stringify(input.eventId)}`,
    `texts: ${input.texts === undefined ? "not shared" : "shared"}`,
    "---",
    "",
    `# ${titleOf(input.message)}`,
    "",
  ];
  // Fenced, like the texts: the person's words and the model's are shown, never rendered,
  // so an image or link in them is never fetched by whoever opens the note.
  const messageFence = fenceFor(input.message);
  lines.push(`${messageFence}text`, input.message, messageFence, "");
  if (input.texts === undefined) {
    lines.push("They did not share their texts with this report.", "");
  } else {
    const fence = fenceFor(input.texts);
    lines.push("## Their recent texts with Tex", "", `${fence}text`, input.texts, fence, "");
  }
  return lines.join("\n");
}

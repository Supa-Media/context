/**
 * Cast blocks: a script, written inside a website page, for the people and
 * agents the homepage shows working in it.
 *
 * The homepage is the console's own shell, and a visitor who sits on it sees
 * a workspace nobody else is in. A cast block is how the page's author makes
 * it look like the product does when a team uses it: somebody types a line,
 * Claude reads a note, an agent adds one. The owner writes the words
 * (2026-09-27, "so I can write it out myself"), and each block sits where its
 * words will appear:
 *
 * ````
 * ```cast
 * @maya types: p.s. this page is live.
 * @jon's Claude writes: new here? [[getting-started]] is the tour.
 * @maya adds to the line above: (the baby can read.)
 * @maya adds a line below: - clearer skin
 * Claude reads: pricing
 * Claude adds note: getting-started
 *   # Getting started
 *   The 90-second tour.
 * wait 4s
 * @maya's Codex comments on "free, you cheapo": a little unprofessional?
 * @jon replies: eh, I don't really care
 * @jon resolves
 * @ana joins
 * @ana clicks @maya
 * @ana ticks: send the invoice
 * @ana leaves
 * @maya opens: pricing
 * @maya types: and this is what it costs.
 * pace: slow
 * ```
 * ````
 *
 * **The block's position is its anchor.** A new line appears where the block
 * was; "adds to the line above" lands at the end of whatever paragraph is
 * above it now. Nothing matches quoted words, so editing the page around a
 * block can move where a step lands but can never make one fail.
 *
 * **A scene has a pace**: `pace: slow`, `lively` (the default) or `fast`, a
 * line anywhere in its blocks, for a film that needs a slower read.
 *
 * **A scene can span pages.** "opens: pricing" moves the show to that page,
 * the way a visitor clicking it would, and every step after it plays there:
 * a new line lands at the end of that page, comments quote its words, and the
 * person who opened it goes along while the rest rejoin when they next act.
 *
 * **A scene can happen in a chat.** "@maya asks Claude: …" opens a chat
 * with that assistant beside the workspace, in a window that looks like no
 * product in particular, and "Claude answers: …" is its reply. From then on
 * what Claude does to the workspace shows in its chat as it happens ("Used
 * Context"), while the workspace changes beside it: that is the film. The
 * workspace steps are the ones an assistant takes through the MCP:
 *
 * ````
 * ```cast
 * chat: side by side, warm
 * @maya asks Claude: we picked Oct 14 for the beta. keep track of it?
 * Claude answers: On it.
 * Claude adds folder: 1-projects/beta-launch
 * Claude adds note: 1-projects/beta-launch/decisions
 *   - Beta ships Oct 14
 * Claude marks beta-launch as: in progress
 * Claude adds task to beta-launch: Invite the first 50 people
 * Claude renames 1-projects/beta-launch/decisions to: launch decisions
 * Claude moves 1-projects/old-notes into: 4-archive
 * @maya opens: 1-projects
 * ```
 * ````
 *
 * `chat:` says how it is framed: side by side (the default) or `cut`, the
 * chat filling the frame until the next "opens"; and a look, warm, plain or
 * dark. More than one assistant can be asked; each gets its own window.
 *
 * On a phone, `phone:` says whether both apps show at once, Context above the
 * chat (`split`, the default), or one at a time (`one app`), switching the way
 * an iPhone does: to the chat when somebody asks, to Context when a step
 * lands there. `shows: Context`, `shows: Claude` or `shows: both` is a cut the
 * script makes itself, at that point in the scene. `keyboard: off` (or `on`)
 * says whether a phone's keyboard comes up while a person types a comment,
 * from that line on; it does by default.
 *
 * **Comments are the exception, because a comment is about words.** "comments
 * on" quotes them and writes a real thread (`comments.cjs`) around the first
 * place they appear; "replies" and "resolves" act on the last thread this
 * page's cast started. Words that are no longer on the page make that step,
 * and the replies to it, do nothing, rather than anchoring somewhere else.
 *
 * A block is never shown as text. `splitWebsiteCast` removes every block and
 * says, in offsets into what is left, where each step belongs; a site that
 * does not play the cast uses `stripWebsiteCast` and draws the page without
 * them. Pure and dependency-free, like the rest of this package.
 */

export type CastActorKind = "person" | "agent";

export interface CastActor {
  /** As written: `@maya`, `Claude`. */
  name: string;
  /** `@handle` is a person; `@handle's Claude` and any other name are agents. */
  kind: CastActorKind;
}

export type CastStep =
  /** A new paragraph at `at`. People type it; an agent's lands whole. */
  | { kind: "line"; actor: CastActor; text: string; at: number }
  /**
   * Text added to the end of the paragraph that ends at `at`, or, with
   * `below`, on a line of its own directly under it: the next item of a list.
   */
  | { kind: "append"; actor: CastActor; text: string; at: number; below?: boolean }
  /** An agent (or person) reading this page, or the page named. */
  | { kind: "read"; actor: CastActor; page: string | null }
  /** A new note in the tree: beside this page, or in `folder` when the name was a path. */
  | { kind: "note"; actor: CastActor; name: string; text: string; folder?: string }
  /** A comment thread on the first appearance of `quote`, with `text` as its first comment. */
  | { kind: "comment"; actor: CastActor; quote: string; text: string }
  /** A reply to the last thread this page's cast started. */
  | { kind: "reply"; actor: CastActor; text: string }
  /** Resolving the last thread this page's cast started. */
  | { kind: "resolve"; actor: CastActor }
  /** Coming into the note: their face appears, with no caret yet. */
  | { kind: "join"; actor: CastActor }
  /** Going: their face and caret leave the note. */
  | { kind: "leave"; actor: CastActor }
  /** Clicking somebody's face, which opens the list of who is here. */
  | { kind: "click"; actor: CastActor; target: string }
  /** Ticking the first open task (`- [ ]`) whose words include `quote`. */
  | { kind: "tick"; actor: CastActor; quote: string }
  /** The show moves to another page, and the steps after this one play there. */
  | { kind: "open"; actor: CastActor; page: string }
  /** Somebody asking an assistant, in a chat of its own: typed into its box, then sent. */
  | { kind: "ask"; actor: CastActor; agent: string; text: string }
  /** An assistant's reply in its chat. */
  | { kind: "answer"; actor: CastActor; text: string }
  /** A new folder, with any folders above it that are missing. */
  | { kind: "folder"; actor: CastActor; path: string }
  /** A note or folder moved into another folder. */
  | { kind: "move"; actor: CastActor; path: string; into: string }
  /** A note or folder given a new name where it is. */
  | { kind: "rename"; actor: CastActor; path: string; name: string }
  /** A project's (or task's) status line set: what a List or Board groups by. */
  | { kind: "status"; actor: CastActor; path: string; status: string }
  /** A new task in a project folder: a note of its own, not started yet. */
  | { kind: "task"; actor: CastActor; project: string; text: string }
  | { kind: "wait"; ms: number }
  /**
   * Which app a phone shows from here: Context, one assistant's chat, or both
   * (`shows: Context`). Nobody does it; it is the film's cut, not an action.
   */
  | { kind: "shows"; what: CastShown }
  /**
   * Whether a phone's keyboard comes up while a person types a comment, from
   * here on (`keyboard: off`); on by default. Nobody does it, like `shows:`.
   */
  | { kind: "keyboard"; on: boolean };

/** What a `shows:` step puts on a phone's screen: `context`, `both`, or an assistant as the script names it. */
export type CastShown = "context" | "both" | (string & {});

/** A step somebody does: every step but a pause and a cut. */
export type CastActing = Extract<CastStep, { actor: CastActor }>;

/** The lines of a page (split on newlines) one step was written on: `from` up to, not including, `to`. */
export interface CastStepSource {
  from: number;
  to: number;
}

export interface WebsiteCast {
  /** The page with every cast block taken out. Offsets in `steps` are into this. */
  markdown: string;
  steps: CastStep[];
  /** Lines that were not understood, for the author; they are skipped. */
  problems: string[];
  /** How fast the scene plays (`pace: slow`); absent is the homepage's own, lively. */
  pace?: CastPaceName;
  /** How its chats are framed (`chat: cut, dark`); absent is side by side, warm. */
  chat?: CastChatSetup;
}

/** How a scene's chats are framed: beside the workspace or filling the frame, and their look. */
export const CAST_CHAT_LAYOUTS = ["side", "cut"] as const;
export type CastChatLayout = (typeof CAST_CHAT_LAYOUTS)[number];
export const CAST_CHAT_LOOKS = ["warm", "plain", "dark"] as const;
export type CastChatLook = (typeof CAST_CHAT_LOOKS)[number];
/**
 * How a phone shows a scene with a chat (Dev2, 2026-09-30): both apps at once,
 * Context above the chat (`split`, the default), or one app at a time filling
 * the screen and switching like an iPhone when the work moves (`one`).
 */
export const CAST_PHONE_LAYOUTS = ["split", "one"] as const;
export type CastPhoneLayout = (typeof CAST_PHONE_LAYOUTS)[number];
export interface CastChatSetup {
  layout: CastChatLayout;
  look: CastChatLook;
  /** On a phone; absent is split. */
  phone?: CastPhoneLayout;
}

/** A scene's speed, written as a line of its own in a cast block. */
export const CAST_PACES = ["slow", "lively", "fast"] as const;
export type CastPaceName = (typeof CAST_PACES)[number];

/** Bounds, so a page cannot script an unbounded show. */
export const MAX_CAST_STEPS = 60;
export const MAX_CAST_TEXT = 600;
export const MAX_CAST_WAIT_MS = 30_000;

const OPEN = /^ {0,3}(`{3,})\s*cast\s*$/i;
const NAME = String.raw`[A-Za-z][A-Za-z0-9._-]{0,30}(?: [A-Za-z0-9][A-Za-z0-9._-]{0,30}){0,2}`;
/** `@maya`, `Claude`, or somebody's agent: `@jon's Claude`. */
const ACTOR = String.raw`(@[A-Za-z0-9][A-Za-z0-9_.-]{0,38}(?:['\u2019]s ${NAME})?|${NAME})`;
const LINE = new RegExp(String.raw`^${ACTOR}\s+(?:types|writes)\s*:\s*(.+)$`, "i");
const APPEND = new RegExp(String.raw`^${ACTOR}\s+adds (to the line above|a line below)\s*:\s*(.+)$`, "i");
const READ = new RegExp(String.raw`^${ACTOR}\s+reads(?:\s*:\s*(.+))?$`, "i");
const NOTE = new RegExp(String.raw`^${ACTOR}\s+adds (?:a )?(?:new )?note\s*:\s*(.+)$`, "i");
const COMMENT = new RegExp(String.raw`^${ACTOR}\s+comments on\s+["\u201c](.+?)["\u201d]\s*:\s*(.+)$`, "i");
const REPLY = new RegExp(String.raw`^${ACTOR}\s+replies\s*:\s*(.+)$`, "i");
const RESOLVE = new RegExp(String.raw`^${ACTOR}\s+resolves(?:\s+(?:it|the comment))?$`, "i");
const JOIN = new RegExp(String.raw`^${ACTOR}\s+(?:joins|comes in)$`, "i");
const LEAVE = new RegExp(String.raw`^${ACTOR}\s+leaves$`, "i");
const CLICK = new RegExp(String.raw`^${ACTOR}\s+clicks(?: on)?\s+${ACTOR}$`, "i");
const TICK = new RegExp(String.raw`^${ACTOR}\s+(?:ticks|checks off|completes)\s*:\s*(.+)$`, "i");
const GOTO = new RegExp(String.raw`^${ACTOR}\s+(?:opens|goes to)\s*:?\s*(.+)$`, "i");
const PACE = /^pace\s*:?\s*(slow|lively|fast)$/i;
const CHAT = /^chat\s*:\s*(.+)$/i;
const PHONE = /^phone\s*:\s*(.+)$/i;
const SHOWS = /^(?:shows?|show on the phone)\s*:\s*(.+)$/i;
const KEYBOARD = /^(?:phone\s+)?keyboard\s*:\s*(.+)$/i;
const AGENT_NAME = new RegExp(String.raw`^${NAME}$`);
const ASK = new RegExp(String.raw`^${ACTOR}\s+asks\s+${ACTOR}\s*:\s*(.+)$`, "i");
const ANSWER = new RegExp(String.raw`^${ACTOR}\s+(?:answers|says)\s*:\s*(.+)$`, "i");
const FOLDER = new RegExp(String.raw`^${ACTOR}\s+adds (?:a )?(?:new )?folder\s*:\s*(.+)$`, "i");
const MOVE = new RegExp(String.raw`^${ACTOR}\s+moves\s+(.+?)\s+into\s*:\s*(.+)$`, "i");
const RENAME = new RegExp(String.raw`^${ACTOR}\s+renames\s+(.+?)\s+to\s*:\s*(.+)$`, "i");
const STATUS = new RegExp(String.raw`^${ACTOR}\s+(?:marks|sets)\s+(.+?)\s+(?:as|to)\s*:\s*(.+)$`, "i");
const TASK = new RegExp(String.raw`^${ACTOR}\s+adds (?:a )?(?:new )?task to\s+(.+?)\s*:\s*(.+)$`, "i");
const WAIT = /^wait\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)?$/i;

function actor(written: string): CastActor {
  // A person is `@handle`; `@handle's Claude` is that person's agent.
  const name = written.replace(/\u2019/g, "'");
  return { name, kind: name.startsWith("@") && !name.includes("'s ") ? "person" : "agent" };
}

function clip(text: string): string {
  return text.trim().slice(0, MAX_CAST_TEXT);
}

/**
 * A path in the tree as written: forward slashes, no leading or trailing one,
 * and never a step up or into Context's own plumbing. A scene plays into a
 * copy of the site in the visitor's tab, but a path is still a path.
 */
function cleanPath(written: string): string {
  return written
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."))
    .join("/")
    .slice(0, 200);
}

/** `side by side, dark`, in any order; a sentence saying what was not understood otherwise. */
function chatSetup(written: string): CastChatSetup | string {
  const setup: CastChatSetup = { layout: "side", look: "warm" };
  for (const raw of written.toLowerCase().split(/[,;]/)) {
    const word = raw.trim().replace(/\s+/g, " ");
    // "chat, then cut" reads as two words, the first saying nothing.
    if (word === "" || word === "chat") continue;
    if (["side by side", "side", "beside"].includes(word)) setup.layout = "side";
    else if (["cut", "then cut", "full", "full screen"].includes(word)) setup.layout = "cut";
    else if ((CAST_CHAT_LOOKS as readonly string[]).includes(word)) setup.look = word as CastChatLook;
    else return `Not a way to show a chat: ${word.slice(0, 60)}. Try side by side or cut, and warm, plain or dark.`;
  }
  return setup;
}

/** `split` or `one app`, however it is said; a sentence saying what was not understood otherwise. */
function phoneLayout(written: string): CastPhoneLayout | string {
  const word = written.trim().toLowerCase().replace(/\s+/g, " ");
  if (["split", "split screen", "both", "both apps", "side by side"].includes(word)) return "split";
  if (["one", "one app", "one app at a time", "full", "full screen", "cut"].includes(word)) return "one";
  return `Not a way to show a phone: ${word.slice(0, 60)}. Try split or one app.`;
}

/** `Context`, `both`, or an assistant's name; a sentence saying what was not understood otherwise. */
function shown(written: string): CastShown | { problem: string } {
  const word = written.trim().replace(/\s+/g, " ");
  const lower = word.toLowerCase();
  if (["context", "the workspace", "workspace"].includes(lower)) return "context";
  if (["both", "both apps", "split", "split screen"].includes(lower)) return "both";
  if (AGENT_NAME.test(word)) return word;
  return { problem: `Not something a phone can show: ${word.slice(0, 60)}. Try Context, both, or an assistant like Claude.` };
}

/** `on` or `off`, however it is said; a sentence saying what was not understood otherwise. */
function keyboardOn(written: string): boolean | string {
  const word = written.trim().toLowerCase();
  if (["on", "yes", "show", "shown", "up"].includes(word)) return true;
  if (["off", "no", "hide", "hidden", "down", "none"].includes(word)) return false;
  return `Not a way to show a keyboard: ${word.slice(0, 60)}. Try on or off.`;
}

/** Parse the lines inside one block. `line` and `append` get their anchors from the caller. */
function parseBlock(
  lines: readonly string[],
  anchors: { line: number; append: number | null },
  steps: CastStep[],
  problems: string[],
  scene: { pace?: CastPaceName; chat?: CastChatSetup },
  spans?: { base: number; out: CastStepSource[] },
): void {
  /*
    Which source lines each step came from, for the studio to edit it in
    place: a step's lines run from the line that started it to the line the
    loop reaches next (a note's body is read inside its own iteration).
  */
  let started = { line: 0, count: steps.length };
  const record = (next: number) => {
    if (spans !== undefined && steps.length > started.count) spans.out.push({ from: spans.base + started.line, to: spans.base + next });
  };
  for (let i = 0; i < lines.length; i += 1) {
    record(i);
    started = { line: i, count: steps.length };
    const raw = lines[i]!;
    const text = raw.trim();
    if (text === "" || text.startsWith("//")) continue;
    if (steps.length >= MAX_CAST_STEPS) {
      problems.push(`More than ${MAX_CAST_STEPS} steps; the rest are skipped.`);
      return;
    }
    let match: RegExpExecArray | null;
    if ((match = PACE.exec(text)) !== null) {
      // The scene's, wherever it is written; the last one written wins.
      scene.pace = match[1]!.toLowerCase() as CastPaceName;
    } else if ((match = CHAT.exec(text)) !== null) {
      const setup = chatSetup(match[1]!);
      if (typeof setup === "string") problems.push(setup);
      // A `phone:` line said before it still holds.
      else scene.chat = scene.chat?.phone === undefined ? setup : { ...setup, phone: scene.chat.phone };
    } else if ((match = PHONE.exec(text)) !== null) {
      const phone = phoneLayout(match[1]!);
      if (phone === "split" || phone === "one") scene.chat = { ...(scene.chat ?? { layout: "side", look: "warm" }), phone };
      else problems.push(phone);
    } else if ((match = KEYBOARD.exec(text)) !== null) {
      const on = keyboardOn(match[1]!);
      if (typeof on === "boolean") steps.push({ kind: "keyboard", on });
      else problems.push(on);
    } else if ((match = SHOWS.exec(text)) !== null) {
      const what = shown(match[1]!);
      if (typeof what === "string") steps.push({ kind: "shows", what });
      else problems.push(what.problem);
    } else if ((match = ASK.exec(text)) !== null) {
      const agent = actor(match[2]!);
      if (agent.kind !== "agent") problems.push(`Only an assistant can be asked, like Claude: ${text.slice(0, 120)}`);
      else steps.push({ kind: "ask", actor: actor(match[1]!), agent: agent.name, text: clip(match[3]!) });
    } else if ((match = ANSWER.exec(text)) !== null) {
      steps.push({ kind: "answer", actor: actor(match[1]!), text: clip(match[2]!) });
    } else if ((match = FOLDER.exec(text)) !== null) {
      const path = cleanPath(match[2]!);
      if (path === "") problems.push(`A folder needs a name: ${text.slice(0, 120)}`);
      else steps.push({ kind: "folder", actor: actor(match[1]!), path });
    } else if ((match = TASK.exec(text)) !== null) {
      steps.push({ kind: "task", actor: actor(match[1]!), project: cleanPath(match[2]!), text: clip(match[3]!).slice(0, 120) });
    } else if ((match = MOVE.exec(text)) !== null) {
      steps.push({ kind: "move", actor: actor(match[1]!), path: cleanPath(match[2]!), into: cleanPath(match[3]!) });
    } else if ((match = RENAME.exec(text)) !== null) {
      steps.push({ kind: "rename", actor: actor(match[1]!), path: cleanPath(match[2]!), name: match[3]!.trim().replace(/[/\\]/g, "-").slice(0, 80) });
    } else if ((match = STATUS.exec(text)) !== null) {
      steps.push({ kind: "status", actor: actor(match[1]!), path: cleanPath(match[2]!), status: match[3]!.trim().toLowerCase().slice(0, 40) });
    } else if ((match = WAIT.exec(text)) !== null) {
      const amount = Number(match[1]);
      const ms = (match[2] ?? "s").toLowerCase() === "ms" ? amount : amount * 1000;
      steps.push({ kind: "wait", ms: Math.min(Math.round(ms), MAX_CAST_WAIT_MS) });
    } else if ((match = NOTE.exec(text)) !== null) {
      // The note's text is the lines under it indented by two spaces or more.
      const body: string[] = [];
      while (i + 1 < lines.length && (/^\s{2,}\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
        i += 1;
        body.push(lines[i]!.replace(/^\s{2}/, ""));
      }
      // A path puts it in that folder: `1-projects/launch/decisions`.
      const written = cleanPath(match[2]!);
      const cut = written.lastIndexOf("/");
      const name = written.slice(cut + 1).slice(0, 80);
      const folder = cut === -1 ? undefined : written.slice(0, cut);
      if (name === "") problems.push(`A note needs a name: ${text}`);
      else if (folder === undefined) steps.push({ kind: "note", actor: actor(match[1]!), name, text: clip(body.join("\n")) });
      else steps.push({ kind: "note", actor: actor(match[1]!), name, text: clip(body.join("\n")), folder });
    } else if ((match = APPEND.exec(text)) !== null) {
      const words = clip(match[3]!);
      const below = match[2]!.toLowerCase() === "a line below";
      // Nothing above the block: the words become a line of their own.
      if (anchors.append === null) steps.push({ kind: "line", actor: actor(match[1]!), text: words, at: anchors.line });
      else if (below) steps.push({ kind: "append", actor: actor(match[1]!), text: words, at: anchors.append, below });
      else steps.push({ kind: "append", actor: actor(match[1]!), text: words, at: anchors.append });
    } else if ((match = LINE.exec(text)) !== null) {
      steps.push({ kind: "line", actor: actor(match[1]!), text: clip(match[2]!), at: anchors.line });
    } else if ((match = COMMENT.exec(text)) !== null) {
      steps.push({ kind: "comment", actor: actor(match[1]!), quote: match[2]!.slice(0, 200), text: clip(match[3]!) });
    } else if ((match = REPLY.exec(text)) !== null || (match = RESOLVE.exec(text)) !== null) {
      if (!steps.some((step) => step.kind === "comment")) problems.push(`Nothing to reply to or resolve yet: ${text.slice(0, 120)}`);
      else if (match[2] === undefined) steps.push({ kind: "resolve", actor: actor(match[1]!) });
      else steps.push({ kind: "reply", actor: actor(match[1]!), text: clip(match[2]) });
    } else if ((match = JOIN.exec(text)) !== null) {
      steps.push({ kind: "join", actor: actor(match[1]!) });
    } else if ((match = LEAVE.exec(text)) !== null) {
      steps.push({ kind: "leave", actor: actor(match[1]!) });
    } else if ((match = CLICK.exec(text)) !== null) {
      steps.push({ kind: "click", actor: actor(match[1]!), target: actor(match[2]!).name });
    } else if ((match = TICK.exec(text)) !== null) {
      steps.push({ kind: "tick", actor: actor(match[1]!), quote: match[2]!.trim().slice(0, 200) });
    } else if ((match = GOTO.exec(text)) !== null) {
      steps.push({ kind: "open", actor: actor(match[1]!), page: match[2]!.trim().slice(0, 120) });
    } else if ((match = READ.exec(text)) !== null) {
      const page = match[2]?.trim();
      steps.push({ kind: "read", actor: actor(match[1]!), page: page ? page.slice(0, 120) : null });
    } else {
      problems.push(`Not understood: ${text.slice(0, 120)}`);
    }
  }
  record(lines.length);
}

/** Whether `line` closes a fence opened with `fence` (the same character, at least as many). */
function closes(line: string, fence: string): boolean {
  const text = line.trim();
  return text.length >= fence.length && [...text].every((c) => c === fence[0]);
}

/**
 * Take the cast blocks out of a page, keeping where each step belongs.
 *
 * An unclosed block is left as it is, a code block the author can see is
 * wrong, rather than swallowing the rest of the page.
 */
export function splitWebsiteCast(source: string): WebsiteCast {
  return splitCast(source);
}

/**
 * The source lines each of a page's steps was written on, in step order, so
 * the studio can change one step without touching the rest of the page.
 */
export function castStepSources(source: string): CastStepSource[] {
  const out: CastStepSource[] = [];
  splitCast(source, out);
  return out;
}

function splitCast(source: string, spans?: CastStepSource[]): WebsiteCast {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let length = 0; // characters in out.join("\n") + "\n" so far
  const steps: CastStep[] = [];
  const problems: string[] = [];
  const scene: { pace?: CastPaceName; chat?: CastChatSetup } = {};
  let fence: string | null = null; // an ordinary code block, whose contents are not ours

  const emit = (line: string) => {
    out.push(line);
    length += line.length + 1;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (fence !== null) {
      if (closes(line, fence)) fence = null;
      emit(line);
      continue;
    }
    const open = OPEN.exec(line);
    if (open === null) {
      const other = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (other !== null) fence = other[1]!;
      emit(line);
      continue;
    }
    const closer = open[1]!;
    let end = i + 1;
    while (end < lines.length && !closes(lines[end]!, closer)) {
      end += 1;
    }
    if (end >= lines.length) {
      problems.push("A cast block is not closed, so it is shown as it is.");
      emit(line);
      continue;
    }
    const before = out.join("\n");
    const trimmed = before.replace(/\s+$/, "");
    parseBlock(
      lines.slice(i + 1, end),
      { line: length, append: trimmed === "" ? null : trimmed.length },
      steps,
      problems,
      scene,
      spans === undefined ? undefined : { base: i + 1, out: spans },
    );
    i = end;
    // One blank line around a removed block is enough: drop the one after it
    // when there is already one before it.
    const previousBlank = out.length === 0 || out[out.length - 1]!.trim() === "";
    if (previousBlank && i + 1 < lines.length && lines[i + 1]!.trim() === "") i += 1;
  }

  const markdown = out.join("\n");
  // `length` counted a newline after the last line, which join does not add.
  const cap = markdown.length;
  for (const step of steps) {
    if ((step.kind === "line" || step.kind === "append") && step.at > cap) step.at = cap;
  }
  const cast: WebsiteCast = { markdown, steps, problems };
  if (scene.pace !== undefined) cast.pace = scene.pace;
  if (scene.chat !== undefined) cast.chat = scene.chat;
  return cast;
}

/**
 * The page with its scene set to `pace`: every `pace` line in its cast blocks
 * taken out, and, unless it is the default (lively), one written as the first
 * line of the first block. A page with no cast block is returned as it is.
 */
export function setCastPace(source: string, pace: CastPaceName): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let cast: string | null = null;
  let written = pace === "lively";
  for (const line of lines) {
    if (cast !== null) {
      if (closes(line, cast)) cast = null;
      else if (PACE.test(line.trim())) continue;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      if (closes(line, fence)) fence = null;
      out.push(line);
      continue;
    }
    const open = OPEN.exec(line);
    out.push(line);
    if (open !== null) {
      cast = open[1]!;
      if (!written) {
        out.push(`pace: ${pace}`);
        written = true;
      }
      continue;
    }
    const other = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (other !== null) fence = other[1]!;
  }
  return written ? out.join("\n") : source;
}

/** The page as a site that does not play the cast draws it. */
export function stripWebsiteCast(source: string): string {
  return splitWebsiteCast(source).markdown;
}

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
 * Claude reads: pricing
 * Claude adds note: getting-started
 *   # Getting started
 *   The 90-second tour.
 * wait 4s
 * @maya's Codex comments on "free, you cheapo": a little unprofessional?
 * @jon replies: eh, I don't really care
 * @jon resolves
 * ```
 * ````
 *
 * **The block's position is its anchor.** A new line appears where the block
 * was; "adds to the line above" lands at the end of whatever paragraph is
 * above it now. Nothing matches quoted words, so editing the page around a
 * block can move where a step lands but can never make one fail.
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
  /** Text added to the end of the paragraph that ends at `at`. */
  | { kind: "append"; actor: CastActor; text: string; at: number }
  /** An agent (or person) reading this page, or the page named. */
  | { kind: "read"; actor: CastActor; page: string | null }
  /** A new note in the tree, beside this page. */
  | { kind: "note"; actor: CastActor; name: string; text: string }
  /** A comment thread on the first appearance of `quote`, with `text` as its first comment. */
  | { kind: "comment"; actor: CastActor; quote: string; text: string }
  /** A reply to the last thread this page's cast started. */
  | { kind: "reply"; actor: CastActor; text: string }
  /** Resolving the last thread this page's cast started. */
  | { kind: "resolve"; actor: CastActor }
  | { kind: "wait"; ms: number };

export interface WebsiteCast {
  /** The page with every cast block taken out. Offsets in `steps` are into this. */
  markdown: string;
  steps: CastStep[];
  /** Lines that were not understood, for the author; they are skipped. */
  problems: string[];
}

/** Bounds, so a page cannot script an unbounded show. */
export const MAX_CAST_STEPS = 60;
export const MAX_CAST_TEXT = 600;
export const MAX_CAST_WAIT_MS = 30_000;

const OPEN = /^ {0,3}(`{3,})\s*cast\s*$/i;
const NAME = String.raw`[A-Za-z][A-Za-z0-9._-]{0,30}(?: [A-Za-z0-9][A-Za-z0-9._-]{0,30}){0,2}`;
/** `@maya`, `Claude`, or somebody's agent: `@jon's Claude`. */
const ACTOR = String.raw`(@[A-Za-z0-9][A-Za-z0-9_.-]{0,38}(?:['\u2019]s ${NAME})?|${NAME})`;
const LINE = new RegExp(String.raw`^${ACTOR}\s+(?:types|writes)\s*:\s*(.+)$`, "i");
const APPEND = new RegExp(String.raw`^${ACTOR}\s+adds to the line above\s*:\s*(.+)$`, "i");
const READ = new RegExp(String.raw`^${ACTOR}\s+reads(?:\s*:\s*(.+))?$`, "i");
const NOTE = new RegExp(String.raw`^${ACTOR}\s+adds (?:a )?(?:new )?note\s*:\s*(.+)$`, "i");
const COMMENT = new RegExp(String.raw`^${ACTOR}\s+comments on\s+["\u201c](.+?)["\u201d]\s*:\s*(.+)$`, "i");
const REPLY = new RegExp(String.raw`^${ACTOR}\s+replies\s*:\s*(.+)$`, "i");
const RESOLVE = new RegExp(String.raw`^${ACTOR}\s+resolves(?:\s+(?:it|the comment))?$`, "i");
const WAIT = /^wait\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)?$/i;

function actor(written: string): CastActor {
  // A person is `@handle`; `@handle's Claude` is that person's agent.
  const name = written.replace(/\u2019/g, "'");
  return { name, kind: name.startsWith("@") && !name.includes("'s ") ? "person" : "agent" };
}

function clip(text: string): string {
  return text.trim().slice(0, MAX_CAST_TEXT);
}

/** Parse the lines inside one block. `line` and `append` get their anchors from the caller. */
function parseBlock(
  lines: readonly string[],
  anchors: { line: number; append: number | null },
  steps: CastStep[],
  problems: string[],
): void {
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const text = raw.trim();
    if (text === "" || text.startsWith("//")) continue;
    if (steps.length >= MAX_CAST_STEPS) {
      problems.push(`More than ${MAX_CAST_STEPS} steps; the rest are skipped.`);
      return;
    }
    let match: RegExpExecArray | null;
    if ((match = WAIT.exec(text)) !== null) {
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
      const name = match[2]!.trim().replace(/[/\\]/g, "-").slice(0, 80);
      if (name === "") problems.push(`A note needs a name: ${text}`);
      else steps.push({ kind: "note", actor: actor(match[1]!), name, text: clip(body.join("\n")) });
    } else if ((match = APPEND.exec(text)) !== null) {
      const words = clip(match[2]!);
      // Nothing above the block: the words become a line of their own.
      if (anchors.append === null) steps.push({ kind: "line", actor: actor(match[1]!), text: words, at: anchors.line });
      else steps.push({ kind: "append", actor: actor(match[1]!), text: words, at: anchors.append });
    } else if ((match = LINE.exec(text)) !== null) {
      steps.push({ kind: "line", actor: actor(match[1]!), text: clip(match[2]!), at: anchors.line });
    } else if ((match = COMMENT.exec(text)) !== null) {
      steps.push({ kind: "comment", actor: actor(match[1]!), quote: match[2]!.slice(0, 200), text: clip(match[3]!) });
    } else if ((match = REPLY.exec(text)) !== null || (match = RESOLVE.exec(text)) !== null) {
      if (!steps.some((step) => step.kind === "comment")) problems.push(`Nothing to reply to or resolve yet: ${text.slice(0, 120)}`);
      else if (match[2] === undefined) steps.push({ kind: "resolve", actor: actor(match[1]!) });
      else steps.push({ kind: "reply", actor: actor(match[1]!), text: clip(match[2]) });
    } else if ((match = READ.exec(text)) !== null) {
      const page = match[2]?.trim();
      steps.push({ kind: "read", actor: actor(match[1]!), page: page ? page.slice(0, 120) : null });
    } else {
      problems.push(`Not understood: ${text.slice(0, 120)}`);
    }
  }
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
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let length = 0; // characters in out.join("\n") + "\n" so far
  const steps: CastStep[] = [];
  const problems: string[] = [];
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
  return { markdown, steps, problems };
}

/** The page as a site that does not play the cast draws it. */
export function stripWebsiteCast(source: string): string {
  return splitWebsiteCast(source).markdown;
}

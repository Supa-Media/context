/**
 * One page's cast, played into that page's shared document.
 *
 * The homepage's cast (`websiteCast.ts` in `@context/shared`) is drawn with the
 * console's own presence: the editor binds a `SharedDoc` exactly as it binds a
 * room's, so a cast member's typing arrives the way a colleague's keystrokes
 * do, and their caret, name flag and highlight are `remoteCarets.ts` drawing a
 * `PresenceMember`. Nothing here draws anything. It writes text into a
 * document nobody else holds and says who is in the note; the shell does the
 * rest, which is what keeps the homepage true to the app as the app changes.
 *
 * No socket and no bucket: the document lives in this tab, and every change
 * reaches only the visitor's own copy of the page (`useLocalFileBrowser`).
 *
 * Comments go through the same document: a thread is its anchor markers and
 * its lines in the note's `comments` block (`comments.cjs`), so the margin
 * draws the cast's comment as it draws anybody's, and a person's reply is
 * typed into its line a letter at a time.
 *
 * **The visitor comes first.** The moment they change the note themselves the
 * cast stops and leaves it, so nobody ever types into a sentence a visitor is
 * writing.
 *
 * Timers come from the host, so the tests drive the whole show with a fake
 * clock and read what it wrote.
 */

import * as Y from "yjs";
import type { CastActor, CastStep } from "@context/shared";
import { addThread, appendEvent, findAnchors, type CommentChange } from "@context/shared/src/comments.cjs";
import type { PresenceMember } from "../../console/presence/protocol";
import { agentName } from "../../console/presence/agentName";
import { presenceColors } from "../../design/tokens";
import { toBase64, type SharedDoc } from "../../console/presence/sharedDoc";

/** The origin of every transaction the cast makes; anything else is the visitor. */
export const CAST_ORIGIN = Symbol("cast");

/** How fast the show runs. `LIVELY` is the owner's pick (2026-09-27). */
export interface CastPace {
  /** Before the first step, so the page is read before anything moves. */
  startMs: number;
  /** Between one step finishing and the next starting. */
  gapMs: number;
  /** A person's keystroke, on average. */
  keyMs: number;
  /** How long an agent's new text stays highlighted before it is plain. */
  highlightMs: number;
  /** After the last step, before people start leaving. */
  lingerMs: number;
  /** Between two members leaving. */
  leaveGapMs: number;
}

export const LIVELY: CastPace = {
  startMs: 1_800,
  gapMs: 2_600,
  keyMs: 70,
  highlightMs: 6_000,
  lingerMs: 8_000,
  leaveGapMs: 1_500,
};

export interface CastHost {
  schedule: (ms: number, run: () => void) => () => void;
  /** Reduced motion: text lands whole, nobody types letter by letter. */
  instant: () => boolean;
  /** The tree path a step's page name means, or `null` when there is none. */
  pageNamed: (name: string) => string | null;
  /** Add a note beside this page. Its tree path, or `null` when it could not be made. */
  addNote: (name: string, text: string) => string | null;
  /** An agent read or wrote a note, for the tree's marks and the agents line. */
  agentDid: (actor: CastActor, kind: "read" | "write", path: string) => void;
  /** Who is in this note now. */
  room: (members: PresenceMember[]) => void;
  /** A comment step acted on this thread: a comment, a reply or a resolve. */
  commented?: (thread: string) => void;
}

/*
  The console's presence palette (`PRESENCE_COLORS` in the gateway), so a cast
  member is drawn in a colour a real member could have. Assigned in order of
  appearance rather than hashed, so two members of one small cast are never
  the same colour; Claude and ChatGPT keep the hues people know them by.
*/
const P = presenceColors;
const PALETTE = [P.pink, P.blue, P.violet, P.cyan, P.lime, P.red, P.green, P.amber];
const KNOWN: Record<string, string> = { claude: P.amber, chatgpt: P.green };

export function castColors(steps: readonly CastStep[]): Map<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<string>();
  for (const step of steps) {
    if (step.kind === "wait" || colors.has(step.actor.name)) continue;
    // "@jon's Claude" is Claude's colour, unless another Claude has it already.
    const known = KNOWN[agentName(step.actor.name).agent.toLowerCase()];
    const reserved = Object.values(KNOWN);
    const color =
      (known !== undefined && !used.has(known) ? known : undefined) ??
      PALETTE.find((one) => !used.has(one) && !reserved.includes(one)) ??
      PALETTE[colors.size % PALETTE.length]!;
    colors.set(step.actor.name, color);
    used.add(color);
  }
  return colors;
}

/** A member id no real member can have: real ids come from the gateway. */
export function castMemberId(actor: CastActor): string {
  return actor.kind === "agent" ? `a:cast-${actor.name}` : `cast:${actor.name}`;
}

/**
 * Play `steps` into `shared`, whose text is the page with its cast blocks
 * already taken out (the offsets in `steps` are into that text).
 */
export function playCast(
  steps: readonly CastStep[],
  shared: SharedDoc,
  host: CastHost,
  options: {
    pace?: CastPace;
    /** This page's own tree path, for a read or write of "this note". */
    path?: string;
    /** Each member's colour, so one person is one colour on every page. */
    colors?: ReadonlyMap<string, string>;
  } = {},
): { stop: () => void } {
  const { doc, text } = shared;
  const pace = options.pace ?? LIVELY;
  const path = options.path ?? "";
  const colors = options.colors ?? castColors(steps);
  const members = new Map<string, PresenceMember>();
  let stopped = false;
  const pending = new Set<() => void>();

  // Where each step lands, pinned to the text now, so earlier steps' writes
  // (and the visitor's, before they stop the show) move them along.
  const anchors = steps.map((step) =>
    step.kind === "line" || step.kind === "append" ? Y.createRelativePositionFromTypeIndex(text, step.at) : null,
  );
  const resolve = (anchor: Y.RelativePosition) =>
    Y.createAbsolutePositionFromRelativePosition(anchor, doc)?.index ?? text.length;
  /*
    A caret *after* the character left of it (`assoc` -1), so each keystroke
    is a new position and `remoteCarets` sees the caret move — which is what
    keeps a typist's name flag up while they type.
  */
  const at = (index: number, assoc: number) =>
    toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc)));

  const later = (ms: number, run: () => void) => {
    if (stopped) return;
    const off = host.schedule(ms, () => {
      pending.delete(off);
      if (!stopped) run();
    });
    pending.add(off);
  };
  const publish = () => host.room([...members.values()]);
  const join = (actor: CastActor) => {
    const id = castMemberId(actor);
    if (!members.has(id)) {
      members.set(id, {
        id,
        name: actor.name,
        color: colors.get(actor.name) ?? null,
        anchor: null,
        head: null,
        canWrite: false,
        isAgent: actor.kind === "agent",
      });
    }
    return id;
  };
  const place = (id: string, anchor: string | null, head: string | null) => {
    const member = members.get(id);
    if (member !== undefined) members.set(id, { ...member, anchor, head });
    publish();
  };
  const write = (index: number, words: string) => {
    doc.transact(() => text.insert(index, words), CAST_ORIGIN);
  };
  /** Changes against the text as it is now, applied together, last first. */
  const change = (changes: readonly CommentChange[]) => {
    doc.transact(() => {
      for (const one of [...changes].sort((a, b) => b.from - a.from)) {
        if (one.to > one.from) text.delete(one.from, one.to - one.from);
        text.insert(one.from, one.insert);
      }
    }, CAST_ORIGIN);
  };
  // The thread this page's cast started last: what "replies" and "resolves" act on.
  let thread: string | null = null;

  // The visitor typed: step out of their way, at once and for good.
  const onChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin !== CAST_ORIGIN) stop();
  };
  text.observe(onChange);

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const off of pending) off();
    pending.clear();
    text.unobserve(onChange);
    members.clear();
    publish();
  }

  const finish = () => {
    const leaving = [...members.keys()];
    const leave = (index: number) => {
      if (index >= leaving.length) {
        stop();
        return;
      }
      members.delete(leaving[index]!);
      publish();
      later(pace.leaveGapMs, () => leave(index + 1));
    };
    later(pace.lingerMs, () => leave(0));
  };

  const next = (index: number) => {
    if (index >= steps.length) return finish();
    const step = steps[index]!;
    const then = () => later(pace.gapMs, () => next(index + 1));

    if (step.kind === "wait") return later(step.ms, () => next(index + 1));

    if (step.kind === "read") {
      const target = step.page === null ? path : host.pageNamed(step.page);
      // Reading this note puts them in it, with no caret: they are reading.
      if (step.page === null || target === path) {
        join(step.actor);
        publish();
      }
      if (target !== null && target !== "" && step.actor.kind === "agent") host.agentDid(step.actor, "read", target);
      return then();
    }

    if (step.kind === "note") {
      const made = host.addNote(step.name, step.text);
      if (made !== null && step.actor.kind === "agent") host.agentDid(step.actor, "write", made);
      return then();
    }

    if (step.kind === "comment" || step.kind === "reply" || step.kind === "resolve") {
      comment(step, then);
      return;
    }

    const id = join(step.actor);
    let cursor = resolve(anchors[index]!);
    if (step.kind === "line") {
      // A paragraph of its own: a blank line on each side of it.
      const before = text.toString().slice(0, cursor);
      const after = text.toString().slice(cursor);
      const prefix = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      const suffix = after === "" ? "\n" : after.startsWith("\n") ? "\n" : "\n\n";
      write(cursor, prefix + suffix);
      cursor += prefix.length;
    } else if (step.text !== "" && !/^[\s,.;:!?)]/.test(step.text)) {
      write(cursor, " ");
      cursor += 1;
    }

    // An agent's write lands whole, highlighted, the way `agentCarets` draws one.
    if (step.actor.kind === "agent" || host.instant()) {
      write(cursor, step.text);
      place(id, at(cursor, 0), at(cursor + step.text.length, -1));
      if (step.actor.kind === "agent") host.agentDid(step.actor, "write", path);
      const end = at(cursor + step.text.length, -1);
      later(pace.highlightMs, () => place(id, end, end));
      return then();
    }

    // A person types it.
    const keys = [...step.text];
    const key = (k: number) => {
      if (k >= keys.length) return then();
      write(cursor, keys[k]!);
      cursor += keys[k]!.length;
      const here = at(cursor, -1);
      place(id, here, here);
      later(keyDelay(keys[k]!, k, pace.keyMs), () => key(k + 1));
    };
    place(id, at(cursor, -1), at(cursor, -1));
    later(pace.keyMs * 3, () => key(0));
  };

  /*
    A comment, a reply or a resolve. The words a thread is about are
    highlighted as the author's selection while they write, the way the
    console shows somebody commenting; the comment itself is typed into its
    log line, where the margin reads it. Words no longer on the page, or a
    reply to a thread that never started, are skipped without a trace.
  */
  function comment(step: Extract<CastStep, { kind: "comment" | "reply" | "resolve" }>, then: () => void) {
    const source = text.toString();
    let result: { changes: CommentChange[]; error?: undefined } | { error: string };
    if (step.kind === "comment") {
      const made = addThread(source, { quote: step.quote, author: step.actor.name, body: step.text });
      thread = made.error === undefined ? made.id : null;
      result = made;
    } else if (thread === null) {
      result = { error: "no thread" };
    } else {
      result = appendEvent(source, {
        thread,
        kind: step.kind === "reply" ? "comment" : "resolved",
        author: step.actor.name,
        body: step.kind === "reply" ? step.text : undefined,
      });
    }
    if (result.error !== undefined) return then();
    const id = join(step.actor);
    const words = () => findAnchors(text.toString()).get(thread!) ?? null;
    const select = () => {
      const range = words();
      if (range === null) return;
      if (step.kind === "resolve") place(id, at(range.to, -1), at(range.to, -1));
      else place(id, at(range.from, 0), at(range.to, -1));
      // The thread is on the page now: the editor opens it, which on a phone
      // is the sheet a visitor opens by tapping the words.
      host.commented?.(thread!);
    };
    const done = () => {
      if (step.actor.kind === "agent") host.agentDid(step.actor, "write", path);
      const range = words();
      if (range !== null) later(pace.highlightMs, () => place(id, at(range.to, -1), at(range.to, -1)));
      then();
    };

    const body = step.kind === "resolve" ? "" : step.text;
    const last = result.changes[result.changes.length - 1]!;
    const within = body === "" ? -1 : last.insert.lastIndexOf(body);
    // An agent's comment lands whole, as does anything that is not one plain line.
    if (step.actor.kind === "agent" || host.instant() || within === -1 || body.includes("\n")) {
      change(result.changes);
      select();
      return done();
    }

    // A person: the words are selected first, then the comment is typed.
    const shift = result.changes.slice(0, -1).reduce((sum, one) => sum + (one.from < last.from ? one.insert.length : 0), 0);
    change([...result.changes.slice(0, -1), { ...last, insert: last.insert.slice(0, within) + last.insert.slice(within + body.length) }]);
    select();
    let cursor = last.from + shift + within;
    const keys = [...body];
    const key = (k: number) => {
      if (k >= keys.length) return done();
      write(cursor, keys[k]!);
      cursor += keys[k]!.length;
      later(keyDelay(keys[k]!, k, pace.keyMs), () => key(k + 1));
    };
    later(pace.keyMs * 3, () => key(0));
  }

  later(pace.startMs, () => next(0));
  return { stop };
}

/** Uneven, the way people type: a beat after a word, a longer one after a sentence. */
function keyDelay(key: string, index: number, base: number): number {
  const wobble = 0.6 + ((index * 37) % 11) / 12;
  if (/[.!?]/.test(key)) return base * 5;
  if (key === " ") return base * 1.8;
  return Math.round(base * wobble);
}

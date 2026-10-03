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
import type { CastActing, CastActor, CastPaceName, CastShown, CastStep } from "@context/shared";
import { addThread, appendEvent, findAnchors, type CommentChange } from "@context/shared/src/comments.cjs";
import type { PresenceMember } from "../../console/presence/protocol";
import { agentName } from "../../console/presence/agentName";
import { presenceColors } from "../../design/tokens";
import { toBase64, type SharedDoc } from "../../console/presence/sharedDoc";
import { chatTool, type CastChatEvent } from "./castChat";
import { terminalSteps } from "./castTerminalPlay";

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

/** Each `pace:` a scene can ask for (`websiteCast.ts`). Every wait scales together. */
function scaled(by: number): CastPace {
  return {
    startMs: Math.round(LIVELY.startMs * by),
    gapMs: Math.round(LIVELY.gapMs * by),
    keyMs: Math.round(LIVELY.keyMs * by),
    highlightMs: Math.round(LIVELY.highlightMs * by),
    lingerMs: Math.round(LIVELY.lingerMs * by),
    leaveGapMs: Math.round(LIVELY.leaveGapMs * by),
  };
}
export const PACES: Record<CastPaceName, CastPace> = { slow: scaled(1.6), lively: LIVELY, fast: scaled(0.6) };

/** The pace a scene asked for, or the homepage's own. */
export function paceNamed(name: CastPaceName | undefined): CastPace {
  return name === undefined ? LIVELY : PACES[name];
}

export interface CastHost {
  schedule: (ms: number, run: () => void) => () => void;
  /** Reduced motion: text lands whole, nobody types letter by letter. */
  instant: () => boolean;
  /** The tree path a step's page name means, or `null` when there is none. */
  pageNamed: (name: string) => string | null;
  /** Add a note beside this page, or in `folder`. Its tree path, or `null` when it could not be made. */
  addNote: (name: string, text: string, folder?: string) => string | null;
  /**
   * The workspace steps an assistant takes through the MCP. Each answers with
   * the path it changed, or `null` when there was nothing to change (a name
   * that is not in the tree): the step is then skipped, not guessed at.
   */
  workspace?: CastWorkspace;
  /** What happens in the scene's chats (`castChat.ts`). */
  chat?: (event: CastChatEvent) => void;
  /** A `shows:` cut: which app a phone shows from here. */
  shows?: (what: CastShown) => void;
  /** `keyboard: on|off`: whether a phone's keyboard comes up for typing from here. */
  keyboard?: (on: boolean) => void;
  /** An agent read or wrote a note, for the tree's marks and the agents line. */
  agentDid: (actor: CastActor, kind: "read" | "write", path: string) => void;
  /** Who is in this note now. */
  room: (members: PresenceMember[]) => void;
  /** A comment step acted on this thread: a comment, a reply or a resolve. */
  commented?: (thread: string) => void;
  /**
   * What a comment step said: the thread's words and the latest entry in it,
   * while a person types it (`draft`) and once it is all written. A phone's
   * Context window shows it as a card, since there is no margin there to hold
   * one, and its keyboard while it is typed.
   */
  said?: (said: CastSaid) => void;
  /** Step `index` of the script is starting: the studio's script follows along. */
  step?: (index: number) => void;
  /** The show ran to its end and everybody has left (not stopped by the visitor). */
  ended?: () => void;
  /** Somebody clicked `name`'s face: the pile opens its list of who is here. */
  clicked?: (name: string) => void;
  /** A moment the studio can put a sound to (`castSounds.ts`). */
  cue?: (moment: CastMoment) => void;
  /**
   * Take the view to the page `name` means, as a visitor clicking it would:
   * its tree path and a document seeded with it, for the rest of the show to
   * play into. `null` when there is no such page, and the show stays here.
   */
  open?: (name: string) => { path: string; shared: SharedDoc | null } | null;
}

/** A comment, reply or resolve as a card says it. */
export interface CastSaid {
  who: string;
  quote: string;
  /** Empty for a resolve. */
  text: string;
  resolved: boolean;
  /** Still being typed: `text` is what is written so far. */
  draft?: boolean;
}

export interface CastWorkspace {
  addFolder: (path: string) => string | null;
  move: (path: string, into: string) => string | null;
  rename: (path: string, name: string) => string | null;
  setStatus: (path: string, status: string) => string | null;
  addTask: (project: string, text: string) => string | null;
}

/**
 * The moments of a show a sound can go with: somebody arriving, a key, an
 * agent's words landing, a comment or reply sent, a thread resolved, a note
 * appearing, an assistant giving up. `click` is for steps the grammar has yet
 * to learn.
 */
export const CAST_MOMENTS = ["join", "agent", "typing", "writes", "click", "comment", "resolve", "note", "error"] as const;
export type CastMoment = (typeof CAST_MOMENTS)[number];

/*
  An answer that is the assistant refusing to go on, the way the products word
  it: a usage or rate limit, an overload, a bare "Error:". Dev2 asked for the
  weekly-limit moment to sound like an error (2026-10-03). Phrases rather than
  the word "error", so an assistant saying it fixed one still sounds like words
  landing.
*/
const GIVES_UP =
  /\b(?:usage limit|limit reached|rate limit|overloaded|out of credits|quota exceeded|something went wrong|try again later)\b|^\s*error\s*:/i;

function givesUp(text: string): boolean {
  return GIVES_UP.test(text);
}

/*
  The console's presence palette (`PRESENCE_COLORS` in the gateway), so a cast
  member is drawn in a colour a real member could have. Assigned in order of
  appearance rather than hashed, so two members of one small cast are never
  the same colour; Claude and ChatGPT keep the hues people know them by, and
  Claude Code and Codex theirs, which their terminals' accents echo.
*/
const P = presenceColors;
const PALETTE = [P.pink, P.blue, P.violet, P.cyan, P.lime, P.red, P.green, P.amber];
const KNOWN: Record<string, string> = { claude: P.amber, chatgpt: P.green, "claude code": P.amber, codex: P.green };

export function castColors(steps: readonly CastStep[]): Map<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<string>();
  for (const step of steps) {
    if (!("actor" in step) || colors.has(step.actor.name)) continue;
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

/** The actor a written name means: `@handle` a person, anything else an agent. */
export function castActorNamed(name: string): CastActor {
  return { name, kind: name.startsWith("@") && !name.includes("'s ") ? "person" : "agent" };
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
    /** Assistants in a terminal (`terminal:`), whose every step shows there from their first. */
    terminals?: readonly string[];
  } = {},
): { stop: () => void } {
  // The page the show is in: the one it started on until a step opens another.
  let { doc, text } = shared;
  let path = options.path ?? "";
  // Moved to another page, a line or an addition lands at its end.
  let moved = false;
  // Moved to a folder's page: there is no text to write into until a page is opened.
  let inFolder = false;
  // The assistants somebody has asked, whose steps show in their chats.
  const chats = new Set<string>((options.terminals ?? []).map((agent) => agent.toLowerCase()));
  let said = 0;
  const pace = options.pace ?? LIVELY;
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
    moved ? text.toString().trimEnd().length : (Y.createAbsolutePositionFromRelativePosition(anchor, doc)?.index ?? text.length);
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
      host.cue?.(actor.kind === "agent" ? "agent" : "join");
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
  let quote = "";

  // The visitor typed: step out of their way, at once and for good.
  const onChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin !== CAST_ORIGIN) stop();
  };
  text.observe(onChange);
  // False while the show is in a folder's page, which has no text to watch.
  let watching = true;

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const off of pending) off();
    pending.clear();
    if (watching) text.unobserve(onChange);
    members.clear();
    publish();
  }

  const finish = () => {
    const leaving = [...members.keys()];
    const leave = (index: number) => {
      if (index >= leaving.length) {
        stop();
        host.ended?.();
        return;
      }
      members.delete(leaving[index]!);
      publish();
      later(pace.leaveGapMs, () => leave(index + 1));
    };
    later(pace.lingerMs, () => leave(0));
  };

  /** An assistant with a chat open, by the name it acts under. */
  const chatOf = (actor: CastActor) => (actor.kind === "agent" && chats.has(actor.name.toLowerCase()) ? actor.name : null);
  /**
   * A step an assistant takes. With its chat open the step shows there as
   * working, and a beat later happens beside it and shows as done, so the eye
   * goes from the chat to the change; without one it just happens.
   */
  const act = (step: CastActing, run: () => void, then: () => void) => {
    const agent = chatOf(step.actor);
    const tool = chatTool(step);
    if (agent === null || tool === null || host.chat === undefined) {
      run();
      return then();
    }
    const id = (said += 1);
    host.chat({ kind: "tool", agent, id, ...tool, done: false });
    later(host.instant() ? 0 : Math.round(pace.gapMs * 0.35), () => {
      run();
      host.chat?.({ kind: "tool", agent, id, ...tool, done: true });
      then();
    });
  };
  /** The same, for a step that writes into the page and ends in its own time: it shows as done at once. */
  const mention = (step: CastActing) => {
    const agent = chatOf(step.actor);
    const tool = chatTool(step);
    if (agent !== null && tool !== null) host.chat?.({ kind: "tool", agent, id: (said += 1), ...tool, done: true });
  };

  const next = (index: number) => {
    if (index >= steps.length) return finish();
    const step = steps[index]!;
    host.step?.(index);
    const then = () => later(pace.gapMs, () => next(index + 1));

    if (step.kind === "wait") return later(step.ms, () => next(index + 1));
    // A cut: the phone shows what the script says from here.
    if (step.kind === "shows") {
      host.shows?.(step.what);
      return then();
    }
    if (step.kind === "keyboard") {
      host.keyboard?.(step.on);
      return then();
    }

    if (step.kind === "run" || step.kind === "edit" || step.kind === "approve" || step.kind === "allow") return terminal(step, then);
    if (step.kind === "ask") return ask(step, then);
    if (step.kind === "answer") return answer(step, then);

    if (step.kind === "read") {
      return act(step, () => {
        const target = step.page === null ? path : host.pageNamed(step.page);
        // Reading this note puts them in it, with no caret: they are reading.
        if (!inFolder && (step.page === null || target === path)) {
          join(step.actor);
          publish();
        }
        if (target !== null && target !== "" && step.actor.kind === "agent") host.agentDid(step.actor, "read", target);
      }, then);
    }

    if (step.kind === "note") {
      return act(step, () => {
        const made = host.addNote(step.name, step.text, step.folder);
        if (made !== null) host.cue?.("note");
        if (made !== null && step.actor.kind === "agent") host.agentDid(step.actor, "write", made);
      }, then);
    }

    if (step.kind === "folder" || step.kind === "move" || step.kind === "rename" || step.kind === "status" || step.kind === "task") {
      return act(step, () => {
        const made = workspaceStep(step, host.workspace);
        if (made === null) return;
        host.cue?.(step.kind === "task" ? "note" : "writes");
        if (step.actor.kind === "agent") host.agentDid(step.actor, "write", made);
      }, then);
    }

    if (step.kind === "join") {
      join(step.actor);
      publish();
      return then();
    }

    if (step.kind === "leave") {
      if (members.delete(castMemberId(step.actor))) publish();
      return then();
    }

    if (step.kind === "click") {
      join(step.actor);
      publish();
      host.cue?.("click");
      host.clicked?.(step.target);
      return then();
    }

    if (step.kind === "open") {
      mention(step);
      const page = host.open?.(step.page) ?? null;
      if (page === null) return then();
      if (watching) text.unobserve(onChange);
      path = page.path;
      thread = null;
      inFolder = page.shared === null;
      watching = page.shared !== null;
      if (page.shared !== null) {
        ({ doc, text } = page.shared);
        moved = true;
        text.observe(onChange);
      }
      // Whoever opened it goes along; the others follow when they next act.
      const opener = castMemberId(step.actor);
      for (const id of [...members.keys()]) if (id !== opener) members.delete(id);
      // No caret yet: where it was is in the page they left.
      place(join(step.actor), null, null);
      host.cue?.("click");
      return then();
    }

    // In a folder's page there are no words to write into.
    if (inFolder) return then();
    mention(step);

    if (step.kind === "tick") {
      // The first open task whose words include the quote; none, and nothing happens.
      const box = openTask(text.toString(), step.quote);
      if (box !== null) {
        const id = join(step.actor);
        change([{ from: box, to: box + 1, insert: "x" }]);
        place(id, at(box + 1, -1), at(box + 1, -1));
        host.cue?.("click");
      }
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
    } else if (step.below === true) {
      // The next line of what is above, with no blank line: a list's next item.
      write(cursor, "\n");
      cursor += 1;
    } else if (step.text !== "" && !/^[\s,.;:!?)]/.test(step.text)) {
      write(cursor, " ");
      cursor += 1;
    }

    // An agent's write lands whole, highlighted, the way `agentCarets` draws one.
    if (step.actor.kind === "agent" || host.instant()) {
      write(cursor, step.text);
      host.cue?.(step.actor.kind === "agent" ? "writes" : "typing");
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
      host.cue?.("typing");
      cursor += keys[k]!.length;
      const here = at(cursor, -1);
      place(id, here, here);
      later(keyDelay(keys[k]!, k, pace.keyMs), () => key(k + 1));
    };
    place(id, at(cursor, -1), at(cursor, -1));
    later(pace.keyMs * 3, () => key(0));
  };

  const terminal = terminalSteps({
    host,
    pace,
    later,
    nextId: () => (said += 1),
    opened: (agent) => chats.add(agent.toLowerCase()),
  });

  /*
    Somebody asking an assistant: a person's words are typed into its box a
    key at a time, the way they type anywhere, then sent. The chat opens with
    the first thing said in it.
  */
  function ask(step: Extract<CastStep, { kind: "ask" }>, then: () => void) {
    chats.add(step.agent.toLowerCase());
    const send = () => {
      host.chat?.({ kind: "ask", agent: step.agent, from: step.actor.name, text: step.text });
      host.cue?.("comment");
      then();
    };
    if (step.actor.kind === "agent" || host.instant()) return send();
    const keys = [...step.text];
    let typed = "";
    const key = (k: number) => {
      if (k >= keys.length) return later(pace.keyMs * 4, send);
      typed += keys[k]!;
      host.chat?.({ kind: "draft", agent: step.agent, from: step.actor.name, text: typed });
      host.cue?.("typing");
      later(keyDelay(keys[k]!, k, pace.keyMs), () => key(k + 1));
    };
    later(pace.keyMs * 3, () => key(0));
  }

  /** An assistant's answer, arriving a few words at a time, the way assistants answer. */
  function answer(step: Extract<CastStep, { kind: "answer" }>, then: () => void) {
    chats.add(step.actor.name.toLowerCase());
    const id = (said += 1);
    host.cue?.(givesUp(step.text) ? "error" : "writes");
    if (host.instant()) {
      host.chat?.({ kind: "answer", agent: step.actor.name, id, text: step.text, done: true });
      return then();
    }
    const words = step.text.match(/\s*\S+/g) ?? [step.text];
    const grow = (n: number) => {
      const done = n >= words.length;
      host.chat?.({ kind: "answer", agent: step.actor.name, id, text: words.slice(0, n).join(""), done });
      if (done) return then();
      later(pace.keyMs * 2, () => grow(n + 1));
    };
    grow(1);
  }

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
      quote = step.quote;
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
      host.cue?.(step.kind === "resolve" ? "resolve" : "comment");
      host.said?.({ who: step.actor.name, quote, text: step.kind === "resolve" ? "" : step.text, resolved: step.kind === "resolve" });
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
    const typed = (k: number) =>
      host.said?.({ who: step.actor.name, quote, text: keys.slice(0, k).join(""), resolved: false, draft: true });
    typed(0);
    const key = (k: number) => {
      if (k >= keys.length) return done();
      write(cursor, keys[k]!);
      typed(k + 1);
      host.cue?.("typing");
      cursor += keys[k]!.length;
      later(keyDelay(keys[k]!, k, pace.keyMs), () => key(k + 1));
    };
    later(pace.keyMs * 3, () => key(0));
  }

  later(pace.startMs, () => next(0));
  return { stop };
}

/** One workspace step, through the host; the path it changed, or `null`. */
function workspaceStep(
  step: Extract<CastStep, { kind: "folder" | "move" | "rename" | "status" | "task" }>,
  workspace: CastWorkspace | undefined,
): string | null {
  if (workspace === undefined) return null;
  switch (step.kind) {
    case "folder":
      return workspace.addFolder(step.path);
    case "move":
      return workspace.move(step.path, step.into);
    case "rename":
      return workspace.rename(step.path, step.name);
    case "status":
      return workspace.setStatus(step.path, step.status);
    case "task":
      return workspace.addTask(step.project, step.text);
  }
}

/** Where the space inside `- [ ]` is, on the first open task mentioning `quote`, or `null`. */
export function openTask(source: string, quote: string): number | null {
  const needle = quote.trim().toLowerCase();
  if (needle === "") return null;
  const task = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[) (\][^\n]*)$/gm;
  for (let match = task.exec(source); match !== null; match = task.exec(source)) {
    if (match[2]!.toLowerCase().includes(needle)) return match.index + match[1]!.length;
  }
  return null;
}

/** Uneven, the way people type: a beat after a word, a longer one after a sentence. */
function keyDelay(key: string, index: number, base: number): number {
  const wobble = 0.6 + ((index * 37) % 11) / 12;
  if (/[.!?]/.test(key)) return base * 5;
  if (key === " ") return base * 1.8;
  return Math.round(base * wobble);
}

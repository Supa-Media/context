import { useEffect, useRef, useState } from "react";
import type { CastPhoneLayout, CastShown } from "@context/shared";
import type { CastChatEvent } from "./castChat";
import type { CastWorkspace } from "./castRun";

/*
  Where Context's window looks while a chat scene plays on a phone (Dev2,
  2026-09-30: "I'd like to show how folders and things are being created as
  you chat"). The chat sits below Context, so a note filling Context's half
  would hide the folders the assistant is making. Each workspace step instead
  shows, for a moment, the folder the change landed in (the phone's own folder
  page: its folders and notes, or a projects folder's List), then goes back to
  the page the scene is on.
*/

/** How long a step's folder stays up before the scene's page comes back. */
export const CAST_PEEK_MS = 2600;

type Steps = CastWorkspace & { addNoteIn: (folder: string, name: string, text: string) => string | null };

const FRONT_NOTE = /^(overview|index|readme)\.md$/i;

function parentOf(path: string): string {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/**
 * The folder whose page shows a step's change: the one it landed in, or, for
 * a status on a project's front note, the folder listing that project, whose
 * List is where the status shows.
 */
export function folderShowing(kind: "made" | "status", path: string): string {
  const parent = parentOf(path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  return kind === "status" && FRONT_NOTE.test(name) ? parentOf(parent) : parent;
}

/** The same workspace, telling `show` which folder each step's change is in. */
export function followWorkspace<T extends Steps>(workspace: T, show: (folder: string) => void): T {
  const shown =
    <A extends unknown[]>(step: (...args: A) => string | null, kind: "made" | "status" = "made") =>
    (...args: A) => {
      const landed = step(...args);
      if (landed !== null) show(folderShowing(kind, landed));
      return landed;
    };
  return {
    ...workspace,
    addFolder: shown(workspace.addFolder),
    move: shown(workspace.move),
    rename: shown(workspace.rename),
    addTask: shown(workspace.addTask),
    addNoteIn: shown(workspace.addNoteIn),
    setStatus: shown(workspace.setStatus, "status"),
  };
}

interface PeekOptions {
  /** Asked at each step, since whether a chat is up is only known after. */
  enabled: () => boolean;
  selected: string | null;
  select: (path: string) => void;
  /** A peek starting (the page it will go back to, and the folder up) or ending (`null`). */
  peeking?: (peek: Peek | null) => void;
}

/** A folder up for a moment, over the page the scene is on. */
export interface Peek {
  home: string | null;
  folder: string;
}

/**
 * The page the scene is on: during a peek that is still the page it will go
 * back to, so the show playing there carries on. Once something else is
 * opened (the scene's own `opens:`, or the visitor), that is the page.
 */
export function scenePage(selected: string | null, peek: Peek | null): string | null {
  return peek !== null && selected === peek.folder ? peek.home : selected;
}

/**
 * `peek(folder)` opens that folder's page for `CAST_PEEK_MS`, then puts back
 * the page that was open before the first of a run of peeks. Off, it does
 * nothing: a wide screen has the whole tree beside the page already.
 */
export function castPeek(current: () => PeekOptions): { peek: (folder: string) => void; stop: () => void } {
  let home: string | null | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const peek = (folder: string) => {
    const { enabled, selected, select, peeking } = current();
    // The workspace's top has no page of its own on the homepage.
    if (!enabled() || folder === "") return;
    if (home === undefined) home = selected;
    stop();
    peeking?.({ home: home ?? null, folder });
    select(folder);
    timer = setTimeout(() => {
      timer = null;
      const back = home;
      home = undefined;
      // Only if the folder is still what's showing: a scene that opened
      // another page meanwhile keeps it.
      const now = current();
      if (back !== null && back !== undefined && back !== folder && now.selected === folder) now.select(back);
      now.peeking?.(null);
    }, CAST_PEEK_MS);
  };
  return { peek, stop };
}

/** `castPeek` for a component: one per mount, stopped when it unmounts. */
export function useCastPeek(options: Omit<PeekOptions, "peeking">): { peek: (folder: string) => void; peeking: Peek | null } {
  const [peeking, setPeeking] = useState<Peek | null>(null);
  const latest = useRef<PeekOptions>({ ...options, peeking: setPeeking });
  latest.current = { ...options, peeking: setPeeking };
  const [peeker] = useState(() => castPeek(() => latest.current));
  useEffect(() => peeker.stop, [peeker]);
  return { peek: peeker.peek, peeking };
}

/**
 * What a phone shows after a chat event. Split keeps both apps up; one app at
 * a time goes to the chat somebody is typing in, and to Context when an
 * assistant starts a step there, so the change lands on screen. An answer
 * stays where the film is: cutting away for every "Done." would be restless.
 */
export function phoneShowsAfter(before: CastShown | undefined, event: CastChatEvent, phone: CastPhoneLayout | undefined): CastShown {
  if (phone !== "one") return before ?? "both";
  if (event.kind === "draft" || event.kind === "ask") return event.agent;
  if (event.kind === "tool" && !event.done) return "context";
  return before ?? event.agent;
}

/** A `shows:` cut, naming an assistant the way its window does when it has one. */
export function phoneShowsCut(what: CastShown, agents: readonly string[]): CastShown {
  if (what === "context" || what === "both") return what;
  return agents.find((agent) => agent.toLowerCase() === what.toLowerCase()) ?? what;
}

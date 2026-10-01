import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CastActor, CastChatSetup, CastPaceName, CastShown, CastStep } from "@context/shared";
import type { ActiveAgent, AgentActivityView, AgentMark } from "../../console/agents/agentActivity";
import type { PresenceMember } from "../../console/presence/protocol";
import { createSharedDoc, seedSharedDoc, type SharedDoc } from "../../console/presence/sharedDoc";
import type { Presence } from "../../console/presence/usePresence";
import { useReducedMotion } from "../../design/useReducedMotion";
import { previewPagePath } from "../castPreview";
import type { HomePage } from "../homeSite";
import { castActorNamed, castMemberId, paceNamed, playCast, type CastWorkspace } from "./castRun";
import { NO_COMMENTS, commentsAfter, type CastComments } from "./castComments";
import { chatReducer, type ChatState } from "./castChat";
import { phoneShowsAfter, phoneShowsCut } from "./castCamera";
import { castPresence } from "./castSite";
import type { StudioStage } from "./useStudioStage";

/**
 * The homepage's cast, for whichever page is open.
 *
 * Opening a page that has a cast plays it once: a shared document is made
 * from the page as the visitor has it, the editor binds it (`castPresence`),
 * and `playCast` types into it. Each page plays once a visit. Leaving a page
 * mid-show ends that show; coming back finds the page as the cast left it,
 * with nobody in it.
 *
 * What agents did stays for the visit, the way the console keeps the last few
 * minutes: the squares in the tree and the "agents active" line.
 */
export function useHomeCast(options: {
  /** Off where there is no web editor to bind, or no live site. */
  enabled: boolean;
  /** Tree path → steps. */
  scripts: ReadonlyMap<string, readonly CastStep[]>;
  /** Tree path → the pace its scene asked for; absent plays lively. */
  paces?: ReadonlyMap<string, CastPaceName>;
  colors: ReadonlyMap<string, string>;
  selectedPath: string | null;
  /** The visitor's copy of every note, which a page's show starts from. */
  notes: Readonly<Record<string, string>>;
  /** Tree path → the site's page, for a step that names one. */
  pages: ReadonlyMap<string, HomePage>;
  /** Add a note without opening it; its tree path, or `null`. */
  addNote: (folder: string, name: string, text: string) => string | null;
  /** Add a note into the folder a script names, made when missing; its tree path, or `null`. */
  addNoteIn?: (folder: string, name: string, text: string) => string | null;
  /** What an assistant in a scene does to the workspace (`castRun.ts`). */
  workspace?: CastWorkspace;
  /** The folder a step names, for an `opens:` that goes to a folder's page. */
  folderNamed?: (name: string) => string | null;
  /** Tree path → how its scene's chats are framed; absent is side by side, warm. */
  chatSetups?: ReadonlyMap<string, CastChatSetup>;
  /** Open the page at this tree path, as the visitor clicking it would. */
  open?: (path: string) => void;
  /**
   * The cast studio's stage (`useStudioStage`), or `null` for a visit. A stage
   * plays on the studio's clock, only once told to start.
   */
  stage?: StudioStage | null;
}): {
  presence: Presence | undefined;
  agents: AgentActivityView | undefined;
  chat: CastChatView | null;
  comments: CastComments;
  /** Whether a phone's keyboard comes up while a comment is typed (`keyboard:`). */
  keyboard: boolean;
  closeChat: () => void;
} {
  const { enabled, scripts, colors, selectedPath } = options;
  const stage = options.stage ?? null;
  const start = stage?.start ?? null;
  const [room, setRoom] = useState<Room | null>(null);
  const [activity, setActivity] = useState<AgentActivityView>({ agents: [], marks: [] });
  // The chats of the show playing, or the last one: they stay to be read until another starts.
  const [chat, setChat] = useState<CastChatView | null>(null);
  // The latest comments, chat or no chat: a phone draws them as cards.
  const [comments, setComments] = useState<CastComments>(NO_COMMENTS);
  const [keyboard, setKeyboard] = useState(true);
  const played = useRef(new Set<string>());
  // The show playing now, and what it was started from.
  const show = useRef<Show | null>(null);
  const reduced = useReducedMotion();

  // Read at the moment a step runs, never captured when the show started.
  const latest = useRef(options);
  latest.current = options;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  // Unmounting ends whatever is playing.
  useEffect(
    () => () => {
      show.current?.end();
      show.current = null;
    },
    [],
  );

  useEffect(() => {
    const path = selectedPath;
    /*
      A show that opened this page itself (`opens:`) carries on here: the view
      followed the show, not the other way round. Anything else that changes
      ends it, the visitor going to another page included.
    */
    const before = show.current;
    if (before !== null && before.at === path && same(before.from, [enabled, scripts, colors, start])) return;
    before?.end();
    show.current = null;
    const steps = path === null ? undefined : scripts.get(path);
    const waiting = stage !== null && start === null;
    if (!enabled || waiting || path === null || steps === undefined || played.current.has(path)) {
      setRoom((current) => (current !== null && current.path === path ? current : null));
      return;
    }
    const shared = createSharedDoc({});
    seedSharedDoc(shared, latest.current.notes[path] ?? "");
    setRoom({ path, shared, members: [] });
    const setup: CastChatSetup = latest.current.chatSetups?.get(path) ?? { layout: "side", look: "warm" };
    setChat(null);
    setComments(NO_COMMENTS);
    setKeyboard(true);
    const seen = played.current;
    seen.add(path);
    let begun = false;
    const here: Show = { at: path, from: [enabled, scripts, colors, start], end: () => {} };
    // Only while this is the room the show is in.
    const inRoom = (fn: (current: Room) => Room) =>
      setRoom((current) => (current !== null && current.path === here.at ? fn(current) : current));
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const clock = start?.clock ?? null;
    // In the studio, the step it asked to play from, once the rush reaches it.
    let live = start === null || start.from === 0;
    const run = playCast(
      steps,
      shared,
      {
        schedule: (ms, fn) => {
          if (clock !== null) {
            begun = true;
            return clock.schedule(ms, fn);
          }
          const timer = setTimeout(() => {
            begun = true;
            fn();
          }, ms);
          return () => clearTimeout(timer);
        },
        // Skipped steps land whole; the one asked for plays as it would.
        instant: () => reducedRef.current || (clock !== null && clock.rushing && !live),
        pageNamed: (name) => pageNamed(name, latest.current.pages, latest.current.notes),
        addNote: (name, text, into) => {
          const { addNote, addNoteIn } = latest.current;
          return into === undefined || addNoteIn === undefined ? addNote(folder, name, text) : addNoteIn(into, name, text);
        },
        workspace: {
          addFolder: (at) => latest.current.workspace?.addFolder(at) ?? null,
          move: (at, into) => latest.current.workspace?.move(at, into) ?? null,
          rename: (at, name) => latest.current.workspace?.rename(at, name) ?? null,
          setStatus: (at, status) => latest.current.workspace?.setStatus(at, status) ?? null,
          addTask: (project, text) => latest.current.workspace?.addTask(project, text) ?? null,
        },
        chat: (event) =>
          setChat((current) => ({
            setup,
            windows: chatReducer(current?.windows ?? [], event),
            active: event.agent,
            shows: phoneShowsAfter(current?.shows, event, setup.phone),
            // Filling the frame, it opens again whenever somebody says something in it.
            hidden: event.kind === "tool" ? (current?.hidden ?? false) : false,
          })),
        shows: (what) =>
          setChat((current) => ({
            setup,
            windows: current?.windows ?? [],
            active: current?.active,
            shows: phoneShowsCut(what, (current?.windows ?? []).map((window) => window.agent)),
            hidden: current?.hidden ?? false,
          })),
        agentDid: (actor, kind, at) => setActivity((current) => recordAgent(current, actor, kind, at, colors, Date.now())),
        room: (members) => inRoom((current) => ({ ...current, members })),
        said: (said) => setComments((current) => commentsAfter(current, said)),
        keyboard: setKeyboard,
        commented: (thread) => inRoom((current) => ({ ...current, focus: { thread, step: (current.focus?.step ?? 0) + 1 } })),
        clicked: (name) =>
          inRoom((current) => ({
            ...current,
            peek: { member: castMemberId(castActorNamed(name)), step: (current.peek?.step ?? 0) + 1 },
          })),
        open: (name) => {
          const open = latest.current.open;
          // A chat filling the frame gives way to the workspace it was changing.
          if (setup.layout === "cut") setChat((current) => (current === null ? null : { ...current, hidden: true }));
          // A comment card belongs to the page it was on.
          setComments(NO_COMMENTS);
          const target = pageNamed(name, latest.current.pages, latest.current.notes);
          if (target === null && open !== undefined) {
            // A folder's page: nothing to write into, and the show carries on beside it.
            const folderAt = latest.current.folderNamed?.(name) ?? null;
            if (folderAt === null || folderAt === here.at) return null;
            here.at = folderAt;
            setRoom(null);
            open(folderAt);
            return { path: folderAt, shared: null };
          }
          if (target === null || target === here.at || open === undefined) return null;
          const next = createSharedDoc({});
          seedSharedDoc(next, latest.current.notes[target] ?? "");
          // Its own cast, if it has one, does not start over this one.
          seen.add(target);
          here.at = target;
          setRoom({ path: target, shared: next, members: [] });
          open(target);
          return { path: target, shared: next };
        },
        step: (index) => {
          if (start !== null && index >= start.from) live = true;
          stage?.step(index);
        },
        ended: () => stage?.ended(),
        // Only what plays: a step rushed past makes no sound.
        cue: (moment) => {
          if (live) stage?.cue(moment);
        },
      },
      // The page it starts on sets the pace, for the whole scene.
      { path, colors, pace: paceNamed(latest.current.paces?.get(path)) },
    );
    if (clock !== null && !live) clock.rush(() => live);
    here.end = () => {
      run.stop();
      // Taken down before it did anything (a remount, the site arriving): it
      // has not been seen, so it still plays.
      if (!begun) seen.delete(path);
    };
    show.current = here;
    // `stage` changes identity with `start`, which is what it is read for here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, selectedPath, scripts, colors, start]);

  const presence = useMemo(
    () => (room === null || room.path !== selectedPath ? undefined : castPresence(room.shared, room.members, room.focus ?? null, room.peek ?? null)),
    [room, selectedPath],
  );
  const closeChat = useCallback(() => setChat(null), []);
  return { presence, agents: activity.agents.length === 0 ? undefined : activity, chat, comments, keyboard, closeChat };
}

/** A scene's chats as the homepage draws them (`CastChat.tsx`). */
export interface CastChatView {
  setup: CastChatSetup;
  windows: ChatState;
  /** The assistant the latest thing happened with: a phone shows its window. */
  active?: string;
  /** What a phone shows: both apps, Context, or one assistant's chat (`castCamera.ts`). */
  shows?: CastShown;
  /** Framed to fill the stage and the scene has cut to the workspace. */
  hidden: boolean;
}

/** The page a show is in, who is there, and what the chip and margin should open. */
interface Room {
  path: string;
  shared: SharedDoc;
  members: PresenceMember[];
  /** The thread the cast last acted on; see `Presence.commentFocus`. */
  focus?: { thread: string; step: number };
  /** The face a cast member clicked, for the pile to open its list on. */
  peek?: { member: string; step: number };
}

/** A show under way: the page it is in now, and how to end it. */
interface Show {
  at: string;
  /** What it was started from; a change to any of it ends the show. */
  from: readonly unknown[];
  end: () => void;
}

function same(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A page a step names: by its title, its address, or its file name. */
export function pageNamed(
  name: string,
  pages: ReadonlyMap<string, HomePage>,
  notes: Readonly<Record<string, string>>,
): string | null {
  const wanted = name.trim().toLowerCase().replace(/\.md$/, "").replace(/^\//, "");
  // Folders stay folders: `inbox/james` is never the root's `inbox-james`.
  const address = previewPagePath(wanted);
  for (const [path, page] of pages) {
    const route = page.routePath.slice(1).toLowerCase();
    if (page.title.toLowerCase() === wanted || route === wanted || route === address) return path;
  }
  for (const path of Object.keys(notes)) {
    const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "").replace(/^\d{2}-/, "");
    if (stem.toLowerCase() === wanted) return path;
  }
  return null;
}

/** One more read or write, as the gateway's `/agent-activity` would report it. */
export function recordAgent(
  current: AgentActivityView,
  actor: CastActor,
  kind: "read" | "write",
  path: string,
  colors: ReadonlyMap<string, string>,
  now: number,
): AgentActivityView {
  const id = castMemberId(actor);
  const before = current.agents.find((agent) => agent.id === id);
  const agent: ActiveAgent = {
    id,
    name: actor.name,
    color: colors.get(actor.name) ?? null,
    at: now,
    kind,
    path,
    reads: (before?.reads ?? 0) + (kind === "read" ? 1 : 0),
    writes: (before?.writes ?? 0) + (kind === "write" ? 1 : 0),
  };
  const mark: AgentMark = { path, kind, at: now, agent: id };
  return {
    agents: [agent, ...current.agents.filter((one) => one.id !== id)],
    marks: [...current.marks.filter((one) => !(one.path === path && one.agent === id)), mark],
  };
}

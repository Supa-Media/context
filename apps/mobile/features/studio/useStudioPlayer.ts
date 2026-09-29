import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { CastMoment } from "../home/cast/castRun";
import { STUDIO_FLAG, asStageEvent, studioCommand, type StudioCommand } from "../home/cast/studioLink";

export type PlayerStatus = "loading" | "ready" | "playing" | "paused" | "ended";

/** How long a finished show rests before Loop plays it again. */
const LOOP_REST_MS = 1_200;

export interface StudioPlayer {
  /** Changes whenever the stage must be a fresh page: the stage's `key`. */
  stageKey: number;
  status: PlayerStatus;
  /** The step playing, `-1` before the first. */
  current: number;
  /** The show's time, in ms. */
  time: number;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  /** Start, pause or carry on, whichever the show is ready for. */
  toggle: () => void;
  /** A fresh page, playing from the top. */
  restart: () => void;
  /** A fresh page, rushed to step `index` and live from there. */
  jump: (index: number) => void;
  /** A fresh page that waits to be started: Record's first screen. */
  hold: () => void;
  /** Start a held page now. */
  start: () => void;
  /** The stage's iframe, for its messages. */
  attach: (frame: HTMLIFrameElement | null) => void;
  /** Called when the show ends by itself (Record uses it). */
  onEnded: MutableRefObject<(() => void) | null>;
  /** Called at each moment of the show that has a sound (`useStudioSounds`). */
  onCue: MutableRefObject<((moment: CastMoment) => void) | null>;
}

/**
 * The studio's side of the stage: what it has asked the page in the iframe to
 * do, and what the page has said back (`studioLink.ts`).
 *
 * Every restart and jump is a fresh page rather than a rewind. The page keeps
 * whatever the show typed, the way a visitor's copy does, so the only clean
 * way back to the top is to load it again; a jump is that page rushed along
 * on its own clock to the step asked for.
 */
export function useStudioPlayer(): StudioPlayer {
  const [stageKey, setStageKey] = useState(0);
  const [status, setStatus] = useState<PlayerStatus>("loading");
  const [current, setCurrent] = useState(-1);
  const [time, setTime] = useState(0);
  const [loop, setLoop] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);
  // What the next page to load is for: start at once from a step, or wait.
  const next = useRef<{ autoStart: boolean; from: number }>({ autoStart: false, from: 0 });
  const onEnded = useRef<(() => void) | null>(null);
  const onCue = useRef<((moment: CastMoment) => void) | null>(null);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  const send = useCallback((command: StudioCommand) => {
    frame.current?.contentWindow?.postMessage(command, window.location.origin);
  }, []);

  const reload = useCallback((autoStart: boolean, from: number) => {
    next.current = { autoStart, from };
    setStatus("loading");
    setCurrent(-1);
    setTime(0);
    setStageKey((key) => key + 1);
  }, []);

  // The page inside can tell it is our stage by this (`isStudioStage`).
  useEffect(() => {
    const flags = window as unknown as Record<string, unknown>;
    flags[STUDIO_FLAG] = true;
    return () => {
      delete flags[STUDIO_FLAG];
    };
  }, []);

  useEffect(() => {
    let rest: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (message: MessageEvent) => {
      if (message.origin !== window.location.origin) return;
      if (frame.current === null || message.source !== frame.current.contentWindow) return;
      const event = asStageEvent(message.data);
      if (event === null) return;
      if (event.kind === "ready") {
        if (next.current.autoStart) {
          send(studioCommand({ kind: "start", from: next.current.from }));
          setStatus("playing");
        } else {
          setStatus("ready");
        }
      } else if (event.kind === "step") {
        setCurrent(event.index);
      } else if (event.kind === "time") {
        setTime(event.ms);
      } else if (event.kind === "cue") {
        onCue.current?.(event.moment);
      } else {
        setStatus("ended");
        onEnded.current?.();
        if (loopRef.current) rest = setTimeout(() => reload(true, 0), LOOP_REST_MS);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (rest !== undefined) clearTimeout(rest);
    };
  }, [send, reload]);

  const toggle = useCallback(() => {
    if (status === "ready") {
      send(studioCommand({ kind: "start", from: 0 }));
      setStatus("playing");
    } else if (status === "playing") {
      send(studioCommand({ kind: "pause" }));
      setStatus("paused");
    } else if (status === "paused") {
      send(studioCommand({ kind: "resume" }));
      setStatus("playing");
    } else if (status === "ended") {
      reload(true, 0);
    }
  }, [status, send, reload]);

  return {
    stageKey,
    status,
    current,
    time,
    loop,
    setLoop,
    toggle,
    restart: useCallback(() => reload(true, 0), [reload]),
    jump: useCallback((index: number) => reload(true, index), [reload]),
    hold: useCallback(() => reload(false, 0), [reload]),
    start: useCallback(() => {
      send(studioCommand({ kind: "start", from: 0 }));
      setStatus("playing");
    }, [send]),
    attach: useCallback((element: HTMLIFrameElement | null) => {
      frame.current = element;
    }, []),
    onEnded,
    onCue,
  };
}

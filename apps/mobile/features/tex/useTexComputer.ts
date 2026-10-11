import { useCallback, useEffect, useRef, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../agent/useConsoleGrant";
import {
  IDLE_POLL_MS,
  LIVE_POLL_MS,
  readFrame,
  texComputerEndpoint,
  type Frame,
  type TexAction,
} from "./texComputer";

/** What the page draws, and what a person can do from it. */
export interface TexComputerState {
  /** `loading` before the first answer; `notYours` when the gateway says so. */
  phase: "loading" | "live" | "off" | "failed" | "notYours";
  frame: Frame | null;
  /** True while an action or a stop is in flight. */
  busy: boolean;
  send: (action: TexAction) => void;
  stop: () => void;
}

/**
 * The frame, polled: about once a second while Tex's browser is running and
 * the page is visible, every few seconds while nothing is, and not at all in
 * a hidden tab. An action answers with a fresh frame, so a tap shows its
 * result without waiting for the next poll.
 *
 * Authenticated exactly as the approvals screen is: a console grant from
 * `useConsoleGrant`, held in memory, replaced once when the gateway refuses
 * it and never in a loop. Nothing typed here is kept: the text goes in the
 * one request that carries it.
 */
export function useTexComputer(options: {
  workspaceId: string | null;
  handle: string | null;
  endpoint: string | null;
}): TexComputerState {
  const mint = useConsoleGrant();
  const { workspaceId, handle, endpoint } = options;
  const [phase, setPhase] = useState<TexComputerState["phase"]>("loading");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const poke = useRef<() => void>(() => {});

  const request = useCallback(
    async (route: "frame" | "input" | "stop", extra: Record<string, unknown> = {}) => {
      const url = endpoint === null ? null : texComputerEndpoint(endpoint, route);
      if (url === null || workspaceId === null || handle === null) return null;
      const call = async (refresh: boolean | { rejected: string }) => {
        const grant = await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh);
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${grant.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ handle, ...extra }),
        });
        return { token: grant.accessToken, status: response.status, body: await response.json().catch(() => null) };
      };
      try {
        let answer = await call(false);
        // A rotated or expired grant: replaced once, never in a loop.
        if (answer.status === 401) answer = await call({ rejected: answer.token });
        return { status: answer.status, body: answer.body };
      } catch {
        return null;
      }
    },
    [endpoint, handle, mint, workspaceId],
  );

  const apply = useCallback((answer: { status: number; body: unknown } | null, mine: number) => {
    if (mine !== epoch.current) return;
    if (answer === null) {
      setPhase((was) => (was === "loading" ? "failed" : was));
      return;
    }
    const read = readFrame(answer.status, answer.body);
    if (read.kind === "frame") {
      setFrame(read.frame);
      setPhase(read.frame.running ? "live" : "off");
    } else if (read.kind === "notYours") {
      setFrame(null);
      setPhase("notYours");
    } else {
      setPhase((was) => (was === "loading" ? "failed" : was));
    }
  }, []);

  useEffect(() => {
    const mine = ++epoch.current;
    setPhase("loading");
    setFrame(null);
    if (workspaceId === null || handle === null || endpoint === null || typeof fetch !== "function") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let inFlight = false;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (!stopped) timer = setTimeout(tick, running ? LIVE_POLL_MS : IDLE_POLL_MS);
    };
    const tick = async () => {
      if (stopped || inFlight) return;
      if (hidden()) return schedule();
      inFlight = true;
      const answer = await request("frame");
      inFlight = false;
      if (stopped) return;
      apply(answer, mine);
      const read = answer === null ? null : readFrame(answer.status, answer.body);
      running = read?.kind === "frame" && read.frame.running;
      if (read?.kind !== "notYours") schedule();
    };
    poke.current = () => void tick();
    void tick();
    const again = () => {
      if (!hidden()) void tick();
    };
    const listens = typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (listens) window.addEventListener("visibilitychange", again);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (listens) window.removeEventListener("visibilitychange", again);
    };
  }, [apply, endpoint, handle, request, workspaceId]);

  const send = useCallback(
    (action: TexAction) => {
      const mine = epoch.current;
      setBusy(true);
      void request("input", { action }).then((answer) => {
        setBusy(false);
        apply(answer, mine);
      });
    },
    [apply, request],
  );

  const stop = useCallback(() => {
    setBusy(true);
    void request("stop").then(() => {
      setBusy(false);
      poke.current();
    });
  }, [request]);

  return { phase, frame, busy, send, stop };
}

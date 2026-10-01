/**
 * The steps only a terminal has, played: a command and what it prints, an
 * edit, and a command asked for and answered (`castTerminal.ts` in
 * `@context/shared` is their grammar). `playCast` hands each one here; what
 * they add up to is a terminal's messages in `castChat.ts`, drawn by
 * `CastTerminal.tsx`. Nothing here touches the workspace: a command runs
 * in the assistant's own folder, not in anybody's notes.
 */

import type { CastTerminalStep } from "@context/shared";
import type { CastChatEvent } from "./castChat";
import type { CastMoment, CastPace } from "./castRun";

export interface TerminalPlayer {
  host: {
    instant: () => boolean;
    chat?: (event: CastChatEvent) => void;
    cue?: (moment: CastMoment) => void;
  };
  pace: CastPace;
  later: (ms: number, run: () => void) => void;
  /** A new id for a message, shared with the chats' others. */
  nextId: () => number;
  /** The assistant's window is a terminal from here on. */
  opened: (agent: string) => void;
}

/** How long one line of output takes to print, for a pace: quick, but each line seen arriving. */
export function lineMs(pace: CastPace): number {
  return Math.max(90, pace.keyMs * 3);
}

/** Plays one terminal step; `then` once it is done. One per show: it keeps the question waiting for an answer. */
export function terminalSteps(player: TerminalPlayer): (step: CastTerminalStep, then: () => void) => void {
  const { host, pace, later } = player;
  // The command an assistant asked to run, until somebody answers it.
  let waiting: { agent: string; id: number; command: string } | null = null;

  return (step, then) => {
    switch (step.kind) {
      case "run": {
        const agent = step.actor.name;
        player.opened(agent);
        const id = player.nextId();
        const printed = (lines: number, done: boolean): CastChatEvent => ({
          kind: "run",
          agent,
          id,
          command: step.command,
          output: step.output.slice(0, lines),
          done,
        });
        host.cue?.("click");
        if (host.instant()) {
          host.chat?.(printed(step.output.length, true));
          return then();
        }
        host.chat?.(printed(0, false));
        const print = (lines: number) => {
          if (lines > step.output.length) {
            host.chat?.(printed(step.output.length, true));
            host.cue?.("writes");
            return then();
          }
          if (lines > 0) {
            host.chat?.(printed(lines, false));
            host.cue?.("typing");
          }
          later(lines === 0 ? Math.round(pace.gapMs * 0.35) : lineMs(pace), () => print(lines + 1));
        };
        return print(0);
      }
      case "edit":
        player.opened(step.actor.name);
        host.chat?.({ kind: "edit", agent: step.actor.name, id: player.nextId(), file: step.file, diff: step.diff });
        host.cue?.("writes");
        return then();
      case "approve":
        player.opened(step.actor.name);
        waiting = { agent: step.actor.name, id: player.nextId(), command: step.command };
        host.chat?.({ kind: "approval", ...waiting, answer: "waiting" });
        host.cue?.("comment");
        return then();
      case "allow": {
        // Nothing asked, or already answered: an answer to nobody is no step.
        if (waiting === null) return then();
        host.chat?.({ kind: "approval", ...waiting, answer: step.allowed ? "allowed" : "denied", by: step.actor.name });
        host.cue?.("click");
        waiting = null;
        return then();
      }
    }
  };
}

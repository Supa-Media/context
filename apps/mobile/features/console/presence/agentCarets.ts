import type { Dispatch } from "react";
import type * as Y from "yjs";
import type { PresenceMember } from "./protocol";
import { cursorPosition } from "./sync";
import type { SharedDoc } from "./sharedDoc";
import type { PresenceAction } from "./session";
import { AGENT_SPAN_WAIT_MS, changedSpan, type TextDeltaOp } from "./agentSpan";
import { peersFrom } from "./peers";
import type { PresenceOptions } from "./presenceContract";

/**
 * How long a tool's caret stays after its write.
 *
 * The same clock the room uses to expire a member who stopped speaking, and
 * for the same reason: past it, the caret is claiming somebody is here who is
 * not. A tool holds no socket, so nothing else will ever take it down.
 */
const MEMBER_IDLE_MS = 45_000;

type Ref<T> = { current: T };

/** What the two helpers below read, all of it from one room. */
export interface AgentCaretInputs {
  path: string;
  dispatch: Dispatch<PresenceAction>;
  agentTimers: Ref<Map<string, number>>;
  agentWatch: Ref<(() => void) | null>;
  pointers: Ref<Map<string, { x: number; y: number; selected: string[] }>>;
  roster: Ref<PresenceMember[]>;
  externalShared: Ref<SharedDoc | null>;
  onPeerPointers: Ref<PresenceOptions["onPeerPointers"]>;
}

/**
 * The carets of tools that hold no socket, for one room. Created when the room
 * opens, in `roomSocket.ts`; the two closures are the ones that used to be
 * declared inline there, moved verbatim.
 */
export function agentCarets({
  path,
  dispatch,
  agentTimers,
  agentWatch,
  pointers,
  roster,
  externalShared,
  onPeerPointers,
}: AgentCaretInputs): {
  holdAgent: (id: string) => void;
  watchAgentWrite: (id: string) => void;
} {
  /*
    **A tool is present while it is writing, and then it is not.**

    It holds no socket, so nothing will ever send a `leave` for it — the room
    cannot know when an agent has stopped, because there was never a
    connection to close. A caret that stayed would be claiming somebody is in
    the note who left minutes ago, which is exactly the lie presence exists
    to remove. So this client drops it, on the same clock the room uses to
    expire a member who stopped speaking.

    Re-armed on every write: an agent making a series of edits stays present
    throughout rather than flickering.
  */
  const holdAgent = (id: string) => {
    const held = agentTimers.current.get(id);
    if (held !== undefined) window.clearTimeout(held);
    agentTimers.current.set(
      id,
      window.setTimeout(() => {
        agentTimers.current.delete(id);
        // Its pointer too, and by hand: a peer's goes down in the `leave`
        // branch below, and this leave never comes off the wire.
        pointers.current.delete(id);
        onPeerPointers.current?.(peersFrom(roster.current, pointers.current));
        dispatch({ type: "frame", notePath: path, frame: { t: "leave", id } });
      }, MEMBER_IDLE_MS),
    );
  };

  /*
    Wait for the authorized read that brings a named agent's write in, and
    sign the text it changed with the agent's caret.

    Only a transaction from `applyRemote` counts: a peer's live keystroke
    arriving in the meantime is theirs, and must not be drawn as the agent's.
    One read, then stop; and stop anyway after `AGENT_SPAN_WAIT_MS`, because
    a later remote update is not evidence of anything.
  */
  const watchAgentWrite = (id: string) => {
    agentWatch.current?.();
    const shared = externalShared.current;
    if (!shared?.appliedRemotely) return;
    const text = shared.text;
    let timer: number | undefined;
    const stop = () => {
      text.unobserve(observer);
      if (timer !== undefined) window.clearTimeout(timer);
      if (agentWatch.current === stop) agentWatch.current = null;
    };
    function observer(event: Y.YTextEvent, transaction: Y.Transaction) {
      if (!shared?.appliedRemotely?.(transaction.origin)) return;
      const span = changedSpan(event.delta as TextDeltaOp[]);
      if (span === null) return;
      stop();
      dispatch({
        type: "frame",
        notePath: path,
        frame: {
          t: "cursor",
          id,
          anchor: cursorPosition(text, span.from),
          head: cursorPosition(text, span.to),
        },
      });
    }
    text.observe(observer);
    timer = window.setTimeout(stop, AGENT_SPAN_WAIT_MS);
    agentWatch.current = stop;
  };

  return { holdAgent, watchAgentWrite };
}

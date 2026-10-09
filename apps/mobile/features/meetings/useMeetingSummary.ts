import { useEffect, useReducer, useRef, useState } from "react";
import { MAX_INSTRUCTION_CHARS, summaryState } from "@context/meetings/summary";
import { useConsoleGrant } from "../agent/useConsoleGrant";
import { gatewayOriginFrom } from "./gateway";
import {
  automaticSummaryDue,
  requestSummary,
  summaryKey,
  summaryMessage,
  type SummaryStatus,
} from "./summaryRequest";

/**
 * Remembers which `workspaceId:path` keys have already asked for an automatic
 * summary in this app session. Module-level on purpose: a note closed and
 * reopened in the same session must not spend another request, and a
 * full reload starts the rule again. Nothing here is persisted.
 */
const automaticStarted = new Set<string>();

export interface UseMeetingSummaryOptions {
  workspaceId: string | null;
  endpoint: string | null;
  path: string | null;
  /** The note's text as the editor shows it. */
  text: string;
  canEdit: boolean;
}

export interface MeetingSummary {
  /** The open note is a meeting, so a summary belongs in it. */
  isMeeting: boolean;
  /** A request for this note is in flight. */
  pending: boolean;
  /** One short line about the last request for this note, or `null`. */
  message: string | null;
  /** Rewrite the summary now, with an optional instruction. */
  redo(instruction?: string): void;
}

interface Outcome {
  key: string;
  message: string | null;
}

/**
 * A meeting's summary, written by the gateway: automatically once per note per
 * session when there is nothing to show, and on demand from Redo.
 *
 * The gateway writes the note itself, and the open editor picks the write up,
 * so this hook never touches the summary text.
 */
export function useMeetingSummary(options: UseMeetingSummaryOptions): MeetingSummary {
  const { workspaceId, endpoint, path, text, canEdit } = options;
  const mint = useConsoleGrant();
  const flights = useRef(new Set<string>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const key = workspaceId !== null && path !== null ? summaryKey(workspaceId, path) : null;
  const pending = key !== null && flights.current.has(key);
  const isMeeting = key !== null && summaryState(text) !== "not_meeting";
  const due =
    key !== null &&
    endpoint !== null &&
    automaticSummaryDue({ key, text, canEdit, pending, started: automaticStarted });

  // Read from the latest render: the effect below must not re-run when `send`
  // changes identity, and the request must see the path it was started for.
  const send = async (args: { force: boolean; instruction?: string }) => {
    if (key === null || workspaceId === null || path === null || endpoint === null) return;
    const origin = gatewayOriginFrom(endpoint);
    flights.current.add(key);
    rerender();
    let status: SummaryStatus = "failed";
    if (origin !== null) {
      try {
        const grant = await mint({ workspaceId: workspaceId as never });
        status = await requestSummary({
          origin,
          token: grant.accessToken,
          path,
          force: args.force,
          instruction: args.instruction,
        });
      } catch {
        status = "failed";
      }
    }
    flights.current.delete(key);
    setOutcome({ key, message: summaryMessage(status) });
    rerender();
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!due || key === null) return;
    automaticStarted.add(key);
    void sendRef.current({ force: false });
  }, [due, key]);

  return {
    isMeeting,
    pending,
    message: key !== null && outcome !== null && outcome.key === key ? outcome.message : null,
    redo(instruction?: string) {
      if (key === null || flights.current.has(key)) return;
      const trimmed = instruction?.trim().slice(0, MAX_INSTRUCTION_CHARS) ?? "";
      void sendRef.current({ force: true, instruction: trimmed === "" ? undefined : trimmed });
    },
  };
}

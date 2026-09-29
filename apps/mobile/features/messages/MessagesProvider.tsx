import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { InAppMessageId } from "@context/shared";
import {
  FRESH_VISIT,
  nextVisit,
  pickMessage,
  readsFrom,
  type MessageCandidate,
  type MessageRead,
  type MessageVisit,
} from "./rules";

/**
 * The one place in-app messages are decided: every message the app shows
 * unasked registers here, and this hands the screen to at most one of them
 * (`rules.ts`). Mounted once, by the signed-in layout, for the whole visit.
 *
 * Outside it — the signed-out homepage drawing the console for visitors, a
 * test — nothing is arbitrated or remembered on an account, and a message
 * shows whenever its own conditions say so.
 */

export interface MarkArgs {
  message: InAppMessageId;
  workspaceId?: string;
  variant?: string;
}

interface Messages {
  arbitrated: boolean;
  reads: readonly MessageRead[] | undefined | "unavailable";
  picked: string | null;
  /** `owner` is one caller: two screens may ask for the same message. */
  offer: (owner: string, candidate: MessageCandidate) => void;
  withdraw: (owner: string) => void;
  mark: (args: MarkArgs) => void;
}

const Standalone: Messages = {
  arbitrated: false,
  reads: "unavailable",
  picked: null,
  offer: () => {},
  withdraw: () => {},
  mark: () => {},
};

const MessagesContext = createContext<Messages>(Standalone);

export function useMessages(): Messages {
  return useContext(MessagesContext);
}

export function MessagesProvider({
  reads: answer,
  children,
}: {
  /** `myMessageReads`, as `useQueries` hands it back. */
  reads: unknown;
  children: ReactNode;
}) {
  // By caller, not by message: see `offer`.
  const [candidates, setCandidates] = useState<ReadonlyMap<string, MessageCandidate>>(new Map());
  const [visit, setVisit] = useState<MessageVisit>(FRESH_VISIT);
  const markOnAccount = useMutation(api.functions.messages.markMessageSeen);

  const offer = useCallback((owner: string, candidate: MessageCandidate) => {
    setCandidates((map) => {
      const was = map.get(owner);
      if (was !== undefined && was.key === candidate.key && was.id === candidate.id && was.seen === candidate.seen) {
        return map;
      }
      const next = new Map(map);
      next.set(owner, candidate);
      return next;
    });
  }, []);

  const withdraw = useCallback((owner: string) => {
    setCandidates((map) => {
      if (!map.has(owner)) return map;
      const next = new Map(map);
      next.delete(owner);
      return next;
    });
  }, []);

  const mark = useCallback(
    ({ message, workspaceId, variant }: MarkArgs) => {
      // A failed save leaves the device's copy, which is carried up next time.
      void markOnAccount({
        message,
        ...(workspaceId === undefined ? {} : { workspaceId: workspaceId as Id<"workspaces"> }),
        ...(variant === undefined ? {} : { variant }),
      }).catch(() => {});
    },
    [markOnAccount],
  );

  const list = useMemo(() => [...candidates.values()], [candidates]);
  const picked = pickMessage(list, visit);
  const pickedCandidate = useMemo(
    () => (picked === null ? null : (list.find((candidate) => candidate.key === picked) ?? null)),
    [list, picked],
  );

  useEffect(() => {
    setVisit((was) => nextVisit(was, pickedCandidate));
  }, [pickedCandidate]);

  const reads = readsFrom(answer);
  const value = useMemo<Messages>(
    () => ({ arbitrated: true, reads, picked, offer, withdraw, mark }),
    [reads, picked, offer, withdraw, mark],
  );
  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

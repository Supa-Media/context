/** The Mail page's conversations and how many are new, for the page and the rail's dot alike. */

import { useMemo } from "react";
import { areasFolderNow } from "../files/jobIcons/jobFoldersNow";
import { conversationsOf, freshCount, type Conversation } from "./model";
import type { MailRoute } from "./MailRouteContext";
import { useMailNotes, useMailSeen, type MailLoad, type MailState } from "./useMailNotes";

export function useConversations(route: MailRoute | undefined, load?: MailLoad): {
  state: MailState;
  conversations: readonly Conversation[];
  fresh: number;
  refresh: () => void;
  markSeen: (path: string, at: string) => void;
} {
  const workspaceId = route?.workspaceId ?? null;
  const { state, refresh } = useMailNotes(workspaceId, route !== undefined, load);
  const { seen, markSeen } = useMailSeen(workspaceId);
  const me = route?.me;
  const conversations = useMemo(() => (state.status === "ready" ? conversationsOf(state.notes, areasFolderNow(), me, seen) : []), [state, me, seen]);
  return { state, conversations, fresh: freshCount(conversations), refresh, markSeen };
}

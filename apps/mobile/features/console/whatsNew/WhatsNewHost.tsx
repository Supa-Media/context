import { useEffect } from "react";
import { useQuery } from "convex/react";

import { api } from "@context/convex/_generated/api";
import { discordLink } from "../../referrals/invites";

import { useWhatsNew } from "./useWhatsNew";
import { WhatsNewPanel } from "./WhatsNewPanel";
import { isUnread, shownWeek } from "./whatsNew";

/** What the account menu needs to draw its row: which week, and a dot. */
export interface WhatsNewEntry {
  week: number;
  unread: boolean;
}

/**
 * The part of What's new that talks to the server, as a component of its own
 * so the console mounts it only for a signed-in person: the homepage's visitor
 * makes no request to the control plane (`homeConsoleFrame.test.ts`), and a
 * hook can't be skipped conditionally. It reports the row upward and draws the
 * panel while it is open. Opening it records the week as read.
 */
export function WhatsNewHost({
  open,
  onClose,
  onEntry,
}: {
  open: boolean;
  onClose: () => void;
  onEntry: (entry: WhatsNewEntry | null) => void;
}) {
  const { state, seenWeek, markSeen, retry } = useWhatsNew();
  // The Discord join link staff keep in the admin console (Community links),
  // never a link written into the app or the page.
  const discord = discordLink(useQuery(api.functions.referrals.communityLinks, {}))?.url ?? null;
  const week = shownWeek(state)?.number ?? null;
  const unread = isUnread(state, seenWeek);

  useEffect(() => {
    onEntry(week === null ? null : { week, unread });
  }, [week, unread, onEntry]);

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen]);

  return open ? <WhatsNewPanel state={state} onClose={onClose} onRetry={retry} discordUrl={discord} /> : null;
}

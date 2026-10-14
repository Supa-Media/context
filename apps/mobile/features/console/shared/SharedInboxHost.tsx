import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { unseenCount, type SharedItem } from "./sharedInbox";

/** What the account menu needs to draw the @shared row: whether anything is new. */
export interface SharedEntry {
  unseen: number;
}

/**
 * The part of @shared's menu row that talks to the server, mounted only for a
 * signed-in person — `WhatsNewHost`'s reason: the homepage's visitor makes no
 * request to the control plane, and a hook cannot be skipped conditionally.
 * It draws nothing and reports the row's dot upward.
 */
export function SharedInboxHost({ onEntry }: { onEntry: (entry: SharedEntry) => void }) {
  const items = useQuery(api.functions.shares.listSharedWithMe) as SharedItem[] | undefined;
  const seenAt = useQuery(api.functions.sharedInbox.sharedSeenAt);
  const unseen = unseenCount(items, seenAt);
  useEffect(() => {
    onEntry({ unseen });
  }, [unseen, onEntry]);
  return null;
}

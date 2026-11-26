/** The Mail page in the document slot (`?mail=1`), or null when it is closed, for `BrowseDocument`. */

import type { ReactNode } from "react";
import { MailPage } from "./MailPage";
import { useMailRoute } from "./MailRouteContext";

/**
 * Drawn where a note would be, filling the slot as the map does: the tree stays beside it, and opening a
 * conversation's note leaves it, as choosing one in the tree does.
 */
export function useMailSlot(
  compact: boolean,
  select: (path: string) => void,
): ReactNode | null {
  const route = useMailRoute();
  if (!route?.open) return null;
  return (
    <MailPage
      route={route}
      compact={compact}
      onOpen={(path) => {
        route.closeMail();
        select(path);
      }}
      onClose={route.closeMail}
    />
  );
}

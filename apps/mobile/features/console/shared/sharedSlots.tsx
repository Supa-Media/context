import type { ReactNode } from "react";
import { StyleSheet } from "react-native";

import { useOptionalGlobalSearchParams } from "../../app/useOptionalLocalSearchParams";
import { StatusBar } from "../../design/components/StatusBar";
import type { ConsoleRouter } from "../layout/types";
import type { ConsoleRoute } from "../nav";
import { SharedSidebar } from "./SharedSidebar";
import type { SharedEntry } from "./SharedInboxHost";
import { SHARED_HREF, sharedNoteHref, sharerLabel } from "./sharedInbox";

/** Whether the console is on @shared, which swaps the tree's column and the status line for its own. */
export function onShared(route: ConsoleRoute): boolean {
  return route.kind === "app" && route.section === "shared";
}

/** The open note's token, from `?note=`: read by the sidebar and the status line, which sit above the route. */
function useOpenToken(): string | null {
  const note = useOptionalGlobalSearchParams<{ note?: string | string[] }>().note;
  const token = Array.isArray(note) ? note[0] : note;
  return token === undefined || token === "" ? null : token;
}

function SidebarSlot({ entry, router, foot }: { entry: SharedEntry; router: ConsoleRouter; foot: ReactNode }) {
  const selected = useOpenToken();
  return (
    <SharedSidebar
      items={entry.items}
      seenAt={entry.seenAt}
      selected={selected}
      onEverything={() => router.push(SHARED_HREF)}
      onOpen={(token) => router.push(sharedNoteHref(token))}
      foot={foot}
    />
  );
}

/** Board A2's foot line: "Shared with me · 4 items", or "Shared by Ana Ruiz" on an open note. */
function StatusSlot({ entry }: { entry: SharedEntry }) {
  const selected = useOpenToken();
  const open = selected === null ? undefined : entry.items?.find((item) => item.token === selected);
  const count = entry.items?.length ?? 0;
  const text =
    open !== undefined ? `Shared by ${sharerLabel(open)}` : `Shared with me · ${count} item${count === 1 ? "" : "s"}`;
  return (
    <StatusBar
      segments={[{ id: "path", text, tone: "quiet", mono: true }]}
      style={styles.statusBar}
      testID="shared-status"
    />
  );
}

/** `AppFrame`'s explorer and status slots on @shared, in place of the tree and the bucket's status. */
export function sharedFrameSlots(entry: SharedEntry, router: ConsoleRouter, foot: ReactNode) {
  return {
    explorer: <SidebarSlot entry={entry} router={router} foot={foot} />,
    status: <StatusSlot entry={entry} />,
  };
}

const styles = StyleSheet.create({
  // The frame's status row draws the surface and the rule, as `Status`'s does.
  statusBar: { flex: 1, minWidth: 0, paddingHorizontal: 0, borderTopWidth: 0, backgroundColor: "transparent" },
});

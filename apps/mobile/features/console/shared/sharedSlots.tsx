import type { ReactNode } from "react";
import { StyleSheet } from "react-native";

import { useOptionalGlobalSearchParams } from "../../app/useOptionalLocalSearchParams";
import { StatusBar } from "../../design/components/StatusBar";
import type { ConsoleRouter } from "../layout/types";
import type { ConsoleRoute } from "../nav";
import { SharedSidebar } from "./SharedSidebar";
import type { SharedEntry } from "./SharedInboxHost";
import { firstOf, openKeyOf, parseGrant } from "./sharedGrant";
import { SHARED_HREF, sharedItemHref, sharedItemKey, sharerLabel, type SharedItem } from "./sharedInbox";

/** Whether the console is on @shared, which swaps the tree's column and the status line for its own. */
export function onShared(route: ConsoleRoute): boolean {
  return route.kind === "app" && route.section === "shared";
}

/**
 * The key of the open row, from the address: the token in `?note=`, or the grant
 * in `?grant=`. Read by the sidebar and the status line, which sit above the route.
 */
function useOpenKey(): string | null {
  const params = useOptionalGlobalSearchParams<{
    note?: string | string[];
    grant?: string | string[];
    by?: string | string[];
    kind?: string | string[];
  }>();
  const note = firstOf(params.note);
  if (note !== undefined && note !== "") return note;
  const grant = parseGrant({ grant: firstOf(params.grant), by: firstOf(params.by), kind: firstOf(params.kind) });
  return grant === null ? null : openKeyOf(grant);
}

/** The address a listed row opens at, found from its key. */
function hrefFor(items: readonly SharedItem[] | undefined, key: string): string | null {
  const item = items?.find((candidate) => sharedItemKey(candidate) === key);
  return item === undefined ? null : sharedItemHref(item);
}

function SidebarSlot({ entry, router, foot }: { entry: SharedEntry; router: ConsoleRouter; foot: ReactNode }) {
  const selected = useOpenKey();
  return (
    <SharedSidebar
      items={entry.items}
      seenAt={entry.seenAt}
      selected={selected}
      onEverything={() => router.push(SHARED_HREF)}
      onOpen={(key) => {
        const href = hrefFor(entry.items, key);
        if (href !== null) router.push(href);
      }}
      foot={foot}
    />
  );
}

/** Board A2's foot line: "Shared with me · 4 items", or "Shared by Ana Ruiz" on an open note. */
function StatusSlot({ entry }: { entry: SharedEntry }) {
  const selected = useOpenKey();
  const open = selected === null ? undefined : entry.items?.find((item) => sharedItemKey(item) === selected);
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

import { StyleSheet } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { StatusBar } from "../../design/components/StatusBar";
import { layout, radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { withMirrorSegment } from "../../offline/mirrorCopy";
import { AccountBlock } from "../AccountBlock";
import { statusSegments } from "../files/status";
import { describeIndexProgress } from "../search/fastSearch";
import { storagePillLabel } from "../storage/pill";
import type { ConsoleData } from "../types";

/**
 * The thumb's half of the console.
 *
 * Only the verbs that have nowhere else to go on a phone. Creating and
 * searching have no gesture of their own — a long press on a row raises what
 * you can do *to a note*, and neither of these is about a note that already
 * exists. The tree toggle is here as well as in the top bar because this is
 * where a thumb is, and the top bar is a stretch on a tall phone.
 */

/**
 * A context with nowhere to keep notes, in the top bar — and nothing else
 * about storage.
 *
 * **It used to name every binding** — `R2 · notes-bucket`, `R2 · managed`,
 * `Dropbox · second/` — as a pill beside search, on every route. For a managed
 * bucket that was a fact the person never chose and cannot act on; for their
 * own it repeated the status strip along the bottom, which already names the
 * bucket, with Settings → Storage behind both. Three pills of equal weight in
 * one corner made the one that mattered impossible to find.
 *
 * So the bar keeps the only storage state that is a problem with a fix behind
 * it: "no bucket connected", warn-toned, and a way in to the storage settings
 * where one gets connected. A connected binding — any provider, managed or
 * not — draws nothing here.
 *
 * `undefined` is a binding that has not answered. Saying "no bucket connected"
 * about it is a warn pill on somebody's own bucket, and `data.loading` does
 * not cover it — see `ConsoleData.storage`.
 */
export function StorageChip({
  data,
  onOpenSettings,
}: {
  data: ConsoleData;
  /** Absent only while there is no selected context to have settings. */
  onOpenSettings?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  // `undefined` is a binding that has not answered. Saying "no bucket
  // connected" about it is a warn pill on somebody's own bucket, and
  // `data.loading` does not cover it — see `ConsoleData.storage`.
  if (data.loading || data.storage !== null) return null;

  const pill = (
    <Pill tone="warn" leading={<Dot tone="warn" />}>
      no bucket connected
    </Pill>
  );

  if (onOpenSettings === undefined) return pill;
  return (
    <PressRow
      accessibilityLabel="Open storage settings"
      onPress={onOpenSettings}
      radius={radii.pill}
      style={styles.storagePress}
      hoverStyle={styles.storagePressHover}
      testID="storage-pill"
    >
      {pill}
    </PressRow>
  );
}

/**
 * Who you are signed in as, and the way out.
 *
 * Presentational now. Ending a session is `useSignOutFlow`, which the console
 * layout owns and hands to both this block and the settings overlay's Sign out
 * row — see that hook for what sign-out actually does to the device's cache
 * and its unsent writes, and why the person is asked first.
 */
export function Account({
  data,
  compact,
  touch = false,
  onOpenSettings,
  onOpenMeetings,
  onSignOut,
}: {
  data: ConsoleData;
  compact: boolean;
  touch?: boolean;
  onOpenSettings?: () => void;
  onOpenMeetings?: () => void;
  onSignOut: () => void;
}) {
  return (
    <AccountBlock
      // The viewer, resolved once in `identity.ts` — never the viewed context.
      // This block used to take the first `kind === "personal"` context (which
      // is somebody else's the moment one is shared with you) and the selected
      // context's capture address, so opening a shared context renamed the
      // signed-in person after it.
      name={data.viewer.name}
      detail={data.viewer.detail}
      initial={data.viewer.initial}
      compact={compact}
      touch={touch}
      onOpenSettings={onOpenSettings}
      onOpenMeetings={onOpenMeetings}
      onSignOut={onSignOut}
    />
  );
}

/**
 * Counts, save state — and the one thing nothing in this UI has ever said:
 * whether your bucket actually supports conditional writes.
 *
 * `SaveResult.conflictCheck` has always come back from the server and has
 * always been thrown away. B2 and Wasabi cannot do conditional writes, so a
 * save there is checked by re-reading first, and "degrade honestly" (see
 * CLAUDE.md) means somebody has to be able to see which one they got.
 */
export function Status({
  data,
  onOpenSync,
}: {
  data: ConsoleData;
  /**
   * Opens the sync sheet — the phone's, reused, so the rows and the answers on
   * them are one implementation. Given only where the sheet can open (Browse),
   * and attached only to the two sync segments.
   */
  onOpenSync?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const segments = statusSegments({
    editor: data.files.editor,
    conflictCheck: data.files.editor.conflictCheck,
    // The bucket's name, from `storagePillLabel` — two call sites once
    // interpolated `provider · bucket` themselves, which is how one of them
    // printed "dropbox · undefined". Not for a managed bucket: its name is a
    // workspace id nobody chose, "R2 · managed" tells somebody nothing they
    // can act on, and this segment's detail says "a bucket which you own".
    storageLabel: data.storage?.managed === true ? null : storagePillLabel(data.storage),
    // How much of this context is in the hosted index, on every console route
    // rather than only in settings — which is the whole of what made a stuck
    // backfill and a working one look the same. `null` for a member, for a
    // context with fast search off, and before the status has answered, and
    // the strip then draws no segment rather than a placeholder.
    index: describeIndexProgress(data.fastSearch.status),
    now: Date.now(),
    // The connection and the writes that have not reached the bucket, from the
    // browser that owns them. They are drawn first: somebody who has lost
    // signal should not have to read past a word count to find that out.
    sync: data.files.sync,
  });

  /*
    Transparent and unpadded, because the frame's own status row already draws
    the surface, the height, the top rule and the gutter — and puts the tree's
    toggle inside it. Two copies of that chrome is a second rule under the
    first and the leading segment indented twice.
  */
  /*
    How much of this context is on the device, from the offline mirror — at
    the front beside "Offline" when part of it is missing and the device is
    offline, and quietly at the end of the leading group otherwise.
  */
  const withMirror = withMirrorSegment(segments, data.files.sync, Date.now()).map((segment) =>
    onOpenSync !== undefined && (segment.id === "queue" || segment.id === "connection")
      ? { ...segment, onPress: onOpenSync }
      : segment,
  );
  return <StatusBar segments={withMirror} style={styles.statusBar} testID="console-status" />;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  statusBar: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 0,
    borderTopWidth: 0,
    backgroundColor: "transparent",
  },

  switcher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minWidth: 0,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  switcherKind: { color: colors.muted },

  /**
   * The pill's press target. `minHeight` is the touch floor — the top bar is
   * one point taller, so the target fills it instead of growing it — and the
   * pill centres inside the taller invisible surface.
   */
  storagePress: {
    minHeight: layout.minTouchTarget,
    justifyContent: "center",
    borderRadius: radii.pill,
  },
  storagePressHover: { backgroundColor: colors.surface3 },
});

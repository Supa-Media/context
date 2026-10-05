import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, layout, radii, space, touchType } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import { targetFolder } from "./files/tree";
import { SelectActionsBar } from "./files/SelectActionsBar";
import { useSelectBar } from "./files/selectActions";
import { scopeLabel } from "./layout/SearchScope";
import { NoteQuickBar, type NoteQuick, type NoteQuickId } from "./NoteQuickBar";
import type { ConsoleData } from "./types";
import { visibilityTierForRole } from "./visibility";

/** Where a quick note from Home lands (Dev2, 2026-09-30: "inbox is the default folder"). */
export const QUICK_NOTE_FOLDER = "0-inbox";

/**
 * Where the round button's note goes: the folder on screen, the folder of the
 * note on screen, and from Home — the workspace's own page — the Inbox. A
 * workspace with no Inbox gets one with its first quick note, because a
 * folder in a bucket is only the notes in it.
 *
 * `null` when that Inbox is not this person's to write in, and the button
 * then asks where (`NewNoteWhere`). See `inboxTakesNotes`.
 */
export function quickNoteFolder(data: ConsoleData): string | null {
  const folder = targetFolder(data.files.listings, data.files.selectedPath);
  if (folder !== "") return folder;
  return inboxTakesNotes(data) ? QUICK_NOTE_FOLDER : null;
}

/**
 * Whether a note written to the Inbox would land, for the person pressing.
 *
 * An owner writes anywhere in their workspace. Anybody else writes only where
 * the workspace is shared with them, and an Inbox is usually the owner's own:
 * private by rule, or absent with a private top level, which is how
 * @context-lc is (the owner's team, 2026-10-02). The server refused that
 * write as "That file does not exist." — rightly, since a private path must
 * read as missing — and nothing opened.
 *
 * Read off what the device has already listed: the Inbox's own listing, its
 * row at the top, or else the top's default, which an absent Inbox would
 * take. A listing of a folder this person may not see reports its nearest
 * visible ancestor's default (`listing.ts` on the server), so this learns
 * nothing about a private Inbox that the person's own tree did not show.
 * With nothing listed yet it says yes and leaves the server to answer, as
 * before.
 */
export function inboxTakesNotes(data: ConsoleData): boolean {
  const role = data.contexts.find((context) => context.id === data.selectedContextId)?.role;
  // An owner, a visitor's demo, or a role not known yet: the Inbox, as always.
  if (visibilityTierForRole(role) !== "team") return true;
  const { listings } = data.files;
  const inbox =
    listings[QUICK_NOTE_FOLDER]?.folderDefault ??
    listings[""]?.entries.find((entry) => entry.kind === "folder" && entry.path === QUICK_NOTE_FOLDER)?.visibility ??
    listings[""]?.folderDefault;
  return inbox !== "private";
}

/**
 * THE PHONE'S BOTTOM BAR IS APPLE NOTES' BAR: SEARCH, AND A NEW NOTE.
 *
 * Approved by the owner on 2026-09-30 (the mobile Home artboards), replacing
 * the five keys of 2026-09-27 — Back, Browse, Search, New and Recent — on
 * every phone screen. A full-width search field with a microphone, within
 * thumb reach, and the round compose button beside it:
 *
 *  - **Back** is the path bar's, at the top left of every inner screen, and
 *    the system's own back gesture.
 *  - **Browse** and **Recent** are Home: it lists every folder, what you open
 *    most and your recent notes, so a key for each was a second copy of it.
 *  - **New** is the round button, and it makes a note at once, in the folder
 *    you are in — from Home, in the Inbox. Held, it raises the sheet with
 *    everything else a `+` can start (a drawing, a folder, a meeting), so
 *    none of those lost their only route on a phone.
 *
 * **There is no microphone in the field any more** (owner, 2026-10-01: *"the
 * microphone button for some reason opens up search"*). It only ever opened
 * search: the app has no speech engine of its own on a phone
 * (`features/voice/engine.ts` says why), so the button was a pointer to the
 * keyboard's microphone key, which is there the moment search opens. A
 * microphone that does not listen reads as a broken one.
 *
 * **In a note the field gives way to the note's own actions** — Share, Move,
 * Ask AI (`NoteQuickBar`) — beside the same compose button (owner, same
 * review): searching from inside a note means leaving it.
 *
 * The bar's room is `AppFrame`'s bottom slot, as it was; this draws what is in
 * it and decides nothing about whether it shows.
 */
export function ConsoleBottomBar({
  data,
  onSearch,
  onCreate,
  onAskWhere,
  note,
}: {
  data: ConsoleData;
  /** The open note's actions; given while a note — not a folder, not Home — is open. */
  note?: { actions: readonly NoteQuick[]; onAction: (id: NoteQuickId) => void };
  /** Opens search, narrowed to `scope` — a folder's path — or across the workspace when `null`. */
  onSearch: (scope: string | null) => void;
  /**
   * Raises the create sheet for a destination — see the `new` action. `null`
   * where that sheet would have no rows at all (`files/createSheet.ts`).
   */
  onCreate: ((folder: string) => void) | null;
  /** Asks which folder a new note goes in, where the Inbox is not this person's (`NewNoteWhere`). */
  onAskWhere: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // Rows picked on a folder page: their actions take the bar until the page leaves select mode (board 16).
  const picking = useSelectBar();
  const folder = quickNoteFolder(data);
  // On a folder's page the field reads "Search in Clients" (board 07b); on Home, "Search".
  const inside = targetFolder(data.files.listings, data.files.selectedPath);
  const scope = inside === "" ? null : inside;
  const search = () => onSearch(scope);
  // A reader cannot write a note; the round button is then only the sheet, if that has rows.
  const canNote = data.files.canEdit;

  // A note with no action this person may take keeps the field rather than an empty capsule.
  const quick = note !== undefined && note.actions.length > 0 ? note : null;

  if (picking !== null) return <SelectActionsBar bar={picking} />;
  return (
    <View
      style={styles.bar}
      testID="notes-bar"
      role="toolbar"
      aria-label={quick === null ? "Search and new note" : "Note actions and new note"}
    >
      {quick !== null ? (
        <NoteQuickBar actions={quick.actions} onAction={quick.onAction} />
      ) : (
        <View style={styles.field}>
          <Pressable
            onPress={search}
            accessibilityRole="button"
            accessibilityLabel={scope === null ? "Search notes" : `Search in ${scopeLabel(scope)}`}
            style={({ pressed }) => [styles.fieldPress, pressed ? styles.fieldPressed : null]}
            testID="notes-bar-search"
          >
            <Icon name="search" size={18} color={colors.muted} />
            <Text style={styles.placeholder} numberOfLines={1}>
              {scope === null ? "Search" : `Search in ${scopeLabel(scope)}`}
            </Text>
          </Pressable>
        </View>
      )}
      {!canNote && onCreate === null ? null : (
        <Pressable
          onPress={
            !canNote
              ? () => onCreate?.(folder ?? "")
              : folder === null
                ? onAskWhere
                : () => data.files.createUntitled(folder, "note")
          }
          onLongPress={onCreate === null ? undefined : () => onCreate(folder ?? QUICK_NOTE_FOLDER)}
          accessibilityRole="button"
          accessibilityLabel={canNote ? "New note" : "Create"}
          accessibilityHint={canNote && onCreate !== null ? "Hold for a drawing, a folder or a meeting" : undefined}
          style={({ pressed }) => [styles.compose, pressed ? styles.composePressed : null]}
          testID="notes-bar-compose"
        >
          <Icon name="compose" size={22} color={colors.ink} />
        </Pressable>
      )}
    </View>
  );
}

const FIELD_HEIGHT = 50;

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      height: layout.bottomBarHeight,
      paddingHorizontal: space.x1,
    },
    field: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      height: FIELD_HEIGHT,
      borderRadius: radii.pill,
      overflow: "hidden",
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    fieldPress: {
      flex: 1,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x4,
    },
    fieldPressed: { backgroundColor: colors.surface2 },
    placeholder: { flex: 1, fontFamily: fonts.body, fontSize: touchType.ui, color: colors.muted },
    compose: {
      width: FIELD_HEIGHT + 2,
      height: FIELD_HEIGHT + 2,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
      boxShadow: shadows.floating,
    },
    composePressed: { opacity: 0.8 },
  });

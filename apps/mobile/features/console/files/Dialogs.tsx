import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, pointerType as t, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { MoveDestination } from "./browser";
import { describeNameProblem } from "./paths";
import { createRows, type CreateRow } from "./createSheet";

/**
 * The console's dialogs.
 *
 * Three shapes, in the mockup's language: a shell, a name prompt, and a
 * destination picker.
 */

function Shell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable
        style={styles.scrim}
        accessibilityLabel="Close"
        onPress={onClose}
      >
        {/* Swallow presses inside the card so the scrim only closes on the scrim. */}
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel={title}>
          <Text variant="paneTitle" role="heading" aria-level={2}>
            {title}
          </Text>
          <View style={styles.body}>{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Said out loud because the file is real and they will meet it somewhere else.
 *
 * The console does not list the placeholder (`isFolderPlaceholder`), so this
 * sentence is the only place it is mentioned before Obsidian shows it — and a
 * README appearing in their vault that the app never mentioned is worse than
 * one line at the moment they make the folder.
 */
export const NEW_FOLDER_HINT =
  "A bucket has no empty folders, so this also writes a README.md placeholder inside it. Context does not list it; Obsidian and anything else that reads your bucket will.";

/**
 * `+`, on a surface with room for exactly one of it.
 *
 * ## Why this exists
 *
 * A phone has no explorer — the tree is gone at that density — so everything
 * somebody *starts* from the console has to fit on the bottom row, and the row
 * has no width for a seventh key (`bottomRowWidth.test.ts`). This is the sheet
 * the one `+` raises, and it is the phone's copy of `CreateButton`'s menu: the
 * same rows, in the same order, from the same function (`createSheet.ts`).
 *
 * ## Nothing here asks for a name except the folder
 *
 * A note and a drawing are made the moment the row is pressed, called
 * `untitled-<date>`, and take their name from the first heading typed into
 * them — *"for new note, new drawing etc should not ask you to title it"*. See
 * `untitled.ts` for the argument and the rename.
 *
 * The folder still goes on to `NamePrompt`, and that is the honest exception
 * rather than an oversight: the reason a note needs no prompt is that it has a
 * title field inside it, and a folder has no inside to type in. An
 * `untitled-2026-09-19/` in somebody's bucket, renameable only from a row menu
 * they have to find, costs more than one text field.
 *
 * ## The meeting is here because the seventh key is gone
 *
 * The bottom row used to carry a microphone of its own, last, behind a
 * separator — *"we no longer need a dedicated mic button on the bottom row,
 * just a plus button that opens different options"*. Recording is one of the
 * things you start, so it is a row here like the rest, and the row that key
 * occupied went back to the six keys either side of it.
 */
export function CreatePrompt({
  folder,
  canEdit,
  onCancel,
  onCreateNote,
  onCreateDrawing,
  onCreateFolder,
  onNewMeeting,
  onNewChat,
}: {
  folder: string;
  /**
   * Whether this person may write here. A read-only context keeps the `+` — a
   * meeting is still something they can start — and loses the three rows that
   * make a file. See `createSheet.ts`.
   */
  canEdit: boolean;
  onCancel: () => void;
  /** Both of these make the thing immediately. Nothing is named here. */
  onCreateNote: () => void;
  onCreateDrawing: () => void;
  onCreateFolder: (name: string) => void;
  /**
   * `null` on a surface with no meeting flow behind it — the fixtures and the
   * landing page's demo console. Absent rather than pressable and inert, which
   * is the contract `onNewChat` keeps below and `CreateButton` keeps for both.
   */
  onNewMeeting: (() => void) | null;
  /** `null` with no engine behind it, or no model key connected. */
  onNewChat: (() => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [naming, setNaming] = useState(false);

  if (naming) {
    return (
      <NamePrompt
        title="New folder"
        description={NEW_FOLDER_HINT}
        confirmLabel="Create"
        onCancel={onCancel}
        onConfirm={onCreateFolder}
      />
    );
  }

  return (
    <Shell title="Create" onClose={onCancel}>
      <Text variant="paneSub">
        {`In ${folder || "the root of your context"}.`}
      </Text>
      <View style={styles.choices}>
        {createRows({
          canEdit,
          chat: onNewChat !== null,
          meeting: onNewMeeting !== null,
        }).map((row) => (
          <PressRow
            key={row}
            accessibilityLabel={ROW_LABELS[row]}
            onPress={() => {
              /*
                The folder is the one row that stays in the dialog: it swaps this
                sheet for `NamePrompt`, so closing first would take the prompt
                with it. Every other row closes and then acts, because the two
                that write a file open the editor on it — and a modal still on
                screen over a note somebody is now being shown is the one order
                that looks like a bug.
              */
              if (row === "new-folder") return setNaming(true);
              onCancel();
              if (row === "new-note") onCreateNote();
              if (row === "new-drawing") onCreateDrawing();
              if (row === "new-chat") onNewChat?.();
              if (row === "new-meeting") onNewMeeting?.();
            }}
            style={styles.choiceRow}
            hoverStyle={styles.listRowHover}
          >
            <Text variant="body">{ROW_TITLES[row]}</Text>
            <Text variant="paneSub">{ROW_SUBS[row]}</Text>
          </PressRow>
        ))}
      </View>
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onCancel} />
      </View>
    </Shell>
  );
}

/**
 * The accessible name of each row — the same words `CreateButton`'s menu uses,
 * because a phone and a desktop calling the same thing two names is how one of
 * them ends up meaning something else.
 */
const ROW_LABELS: Record<CreateRow, string> = {
  "new-meeting": "New meeting",
  "new-note": "New note",
  "new-drawing": "New drawing",
  "new-folder": "New folder",
  "new-chat": "New chat",
};

/** The word on the row. Shorter than the label: the sheet has a title. */
const ROW_TITLES: Record<CreateRow, string> = {
  "new-meeting": "Meeting",
  "new-note": "Note",
  "new-drawing": "Drawing",
  "new-folder": "Folder",
  "new-chat": "Chat",
};

const ROW_SUBS: Record<CreateRow, string> = {
  "new-meeting": "Records into your inbox. It asks before it listens.",
  "new-note": "A markdown file you can write in.",
  "new-drawing": "An Excalidraw canvas. Opens in Obsidian too.",
  "new-folder": "A place to file notes. Nest them as deep as you like.",
  "new-chat": "Ask about this note, or your whole context.",
};

/** Ask for a name. Validated as you type, with the reason next to the field. */
export function NamePrompt({
  title,
  description,
  confirmLabel,
  initialValue = "",
  onCancel,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  initialValue?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [value, setValue] = useState(initialValue);
  const problem = value.trim() === "" ? null : describeNameProblem(value);
  const ready = value.trim() !== "" && problem === null;

  return (
    <Shell title={title} onClose={onCancel}>
      {description ? <Text variant="paneSub">{description}</Text> : null}
      <TextInput
        value={value}
        onChangeText={setValue}
        autoFocus
        style={styles.input}
        placeholder="name"
        placeholderTextColor={colors.muted}
        accessibilityLabel={title}
        onSubmitEditing={() => {
          if (ready) onConfirm(value.trim());
        }}
      />
      {problem ? <Text variant="error">{problem}</Text> : null}
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onCancel} />
        <Button
          label={confirmLabel}
          variant="dialogPrimary"
          disabled={!ready}
          onPress={() => onConfirm(value.trim())}
        />
      </View>
    </Shell>
  );
}

/**
 * Choose a destination folder.
 *
 * A list rather than drag-and-drop: React Native Web has no dependable
 * HTML5 drag target, and the alternative is a gesture library — a new native
 * dependency, which this repo gates carefully and which would buy an
 * interaction that is worse on a phone anyway. A list is also the only version
 * that works with a keyboard.
 */
/**
 * A narrowing `typeof x === "object"` cannot do on its own.
 *
 * `typeof null` is `"object"`, so the obvious check reads `null` — this
 * context, the case with no remote list at all — as a loaded one and asks it
 * for `.folders`.
 */
function isFolderList(
  value: { folders: readonly string[]; truncated: boolean } | "loading" | "failed" | null,
): value is { folders: readonly string[]; truncated: boolean } {
  return value !== null && typeof value === "object";
}

export function MovePicker({
  title,
  description,
  folders,
  currentFolder,
  destinations = [],
  loadDestinationFolders,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** A consequence worth reading before choosing — see `sharesBreakingWarning`. */
  description?: string;
  folders: readonly string[];
  currentFolder: string;
  /**
   * Other contexts this can go to. Empty is the ordinary case — one context,
   * or somebody who does not own this one — and the row of context buttons is
   * then absent rather than a single disabled option.
   */
  destinations?: readonly MoveDestination[];
  /** Fetches a destination's folders, once, when it is first chosen. */
  loadDestinationFolders?: (contextId: string) => Promise<{
    folders: readonly string[];
    truncated: boolean;
  }>;
  onCancel: () => void;
  /** `contextId` is `null` for this context, which is the unchanged path. */
  onConfirm: (folder: string, contextId: string | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [chosen, setChosen] = useState<string | null>(null);
  const [context, setContext] = useState<string | null>(null);
  /**
   * Folders per destination, kept after the first fetch.
   *
   * A walk of somebody else's bucket per press would make flipping between two
   * contexts to compare them cost a credential open each way. The dialog is
   * short-lived, so "until it closes" is the right lifetime and there is
   * nothing to invalidate.
   */
  const [remote, setRemote] = useState<
    Record<string, { folders: readonly string[]; truncated: boolean } | "loading" | "failed">
  >({});

  const pick = (contextId: string | null) => {
    setContext(contextId);
    // The chosen folder belongs to the context it was chosen in. Keeping it
    // across a switch would arm "Move here" with a path the other context may
    // not even have.
    setChosen(null);
    if (contextId === null || remote[contextId] !== undefined) return;
    setRemote((current) => ({ ...current, [contextId]: "loading" }));
    void loadDestinationFolders?.(contextId)
      .then((answer) => setRemote((current) => ({ ...current, [contextId]: answer })))
      .catch(() => setRemote((current) => ({ ...current, [contextId]: "failed" })));
  };

  // `null` for this context, `undefined` for one nothing has been asked about
  // yet, and the three loaded states otherwise. Kept apart because "not asked"
  // and "asked and empty" draw differently.
  const loaded: { folders: readonly string[]; truncated: boolean } | "loading" | "failed" | null =
    context === null ? null : (remote[context] ?? "loading");
  const available =
    context === null ? folders : isFolderList(loaded) ? loaded.folders : [];
  const elsewhere = destinations.find((one) => one.id === context) ?? null;

  return (
    <Shell title={title} onClose={onCancel}>
      {description ? <Text variant="paneSub">{description}</Text> : null}
      {destinations.length > 0 ? (
        <View style={styles.pills}>
          <Button
            label="This context"
            variant={context === null ? "dialogPrimary" : "dialog"}
            onPress={() => pick(null)}
          />
          {destinations.map((destination) => (
            <Button
              key={destination.id}
              label={destination.label}
              variant={context === destination.id ? "dialogPrimary" : "dialog"}
              onPress={() => pick(destination.id)}
            />
          ))}
        </View>
      ) : null}
      <Text variant="paneSub">
        {elsewhere === null
          ? "Pick where it should live. Nothing is overwritten."
          : /*
              Three things a person cannot see from the folder list, said before
              they press rather than discovered afterwards. Each is a real
              property of a move across a tenancy boundary and none of them is
              a defect: links live in the bucket they were written in, the
              privacy manifest they land under is the other context's, and the
              bytes cross a batch at a time.
            */
            `Moving into ${elsewhere.label}. Links to it are not rewritten, and nothing ` +
            "becomes visible to anybody it was not already visible to — private stays " +
            "private there. A large folder keeps going in the background."}
      </Text>
      {loaded === "loading" ? <Text variant="paneSub">Reading its folders…</Text> : null}
      {loaded === "failed" ? (
        <Text variant="error">That context&apos;s folders could not be read.</Text>
      ) : null}
      {isFolderList(loaded) && loaded.truncated ? (
        <Text variant="paneSub">
          Showing the first {loaded.folders.length} folders of that context.
        </Text>
      ) : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {available.map((folder) => {
          const here = context === null && folder === currentFolder;
          return (
            <PressRow
              key={folder || "/"}
              accessibilityLabel={folder === "" ? "the root of your context" : folder}
              selected={folder === chosen}
              onPress={() => setChosen(folder)}
              radius={radii.sm}
              style={styles.listRow}
              hoverStyle={styles.listRowHover}
              selectedStyle={styles.listRowOn}
            >
              <Text variant="tree" style={folder === chosen ? styles.listRowOnLabel : undefined}>
                {folder === "" ? "/ (root)" : folder}
              </Text>
              {here ? (
                <Text variant="treeMeta" style={styles.listRowMeta}>
                  where it is now
                </Text>
              ) : null}
            </PressRow>
          );
        })}
      </ScrollView>
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onCancel} />
        <Button
          label={elsewhere === null ? "Move here" : `Move to ${elsewhere.label}`}
          variant="dialogPrimary"
          // Only "the folder it is already in" is refused, and only in this
          // context: the same path in another one is a different place.
          disabled={chosen === null || (context === null && chosen === currentFolder)}
          onPress={() => onConfirm(chosen!, context)}
        />
      </View>
    </Shell>
  );
}

/** A plain confirmation. Used for archiving, which is recoverable. */
export function Confirm({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Shell title={title} onClose={onCancel}>
      <Text variant="paneSub">{body}</Text>
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onCancel} />
        <Button label={confirmLabel} variant="dialogPrimary" onPress={onConfirm} />
      </View>
    </Shell>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 22,
    paddingHorizontal: 24,
    boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
  },
  body: { marginTop: 12, gap: 12 },
  input: {
    fontFamily: fonts.mono,
    fontSize: t.ui,
    color: colors.text,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
  },
  /**
   * The action row, and the one rule about what goes in it: `dialog` for the
   * quiet half, `dialogPrimary` for the default action, and nothing else.
   *
   * Every row here used to be `mini` beside `white` — the landing page's hero
   * CTA — so the confirm was drawn with over twice Cancel's padding in both
   * axes. `dialogActionSize.test.ts` measures all three dialogs rather than
   * the one that got noticed.
   */
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  /**
   * The row of contexts a move can go to.
   *
   * Wraps rather than scrolls: somebody with six contexts should see all six
   * at once — a destination you have to scroll to find is one you pick the
   * wrong one of.
   */
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  /**
   * The two rows of the create chooser.
   *
   * In the same well the destination picker's list sits in, so the thing being
   * chosen from reads the same on both dialogs — but with no `maxHeight`,
   * because there are exactly two rows and a scroller around two rows says
   * there might be more.
   */
  choices: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    overflow: "hidden",
  },
  /**
   * A row of the chooser. Taller than the destination picker's rows because it
   * carries two lines and is a thumb target rather than a list to scan — this
   * dialog only exists on the density where the pointer does not.
   */
  choiceRow: { gap: 2, paddingVertical: 12, paddingHorizontal: 14 },
  list: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
  },
  listContent: { padding: 7 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: radii.sm,
  },
  listRowHover: { backgroundColor: colors.surface3 },
  listRowOn: { backgroundColor: colors.accentDim },
  listRowOnLabel: { color: colors.accentText },
  listRowMeta: { marginLeft: "auto" },
  hint: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  hintStrong: { color: colors.hintStrong, fontFamily: fonts.mono },
});

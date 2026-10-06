import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button, PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, pointerType as t, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { MoveDestination } from "./browser";
import { baseName, describeNameProblem, folderLabel } from "./paths";
import { Shell } from "./DialogShell";
import { NewFolderForm } from "./NewFolderForm";
import { PlacePicker } from "./PlacePicker";
import { DestinationTree } from "./DestinationTree";
import { useDestinationFolders, type FolderLoad } from "./useDestinationFolders";
import { createRows, type CreateRow } from "./createSheet";
import { useFieldFont } from "../../design/fieldFont";

/**
 * The console's dialogs.
 *
 * Three shapes, in the mockup's language: a shell, a name prompt, and a
 * destination picker.
 */

/** Where something made in `folder` lands, in words: a folder's name, or the top. */
export function whereIn(folder: string): string {
  return folder === "" ? "the top of your workspace" : folderLabel(baseName(folder));
}

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
  folders = [""],
  rootLabel = "Your workspace",
  onNewMeeting,
  onNewChat,
  onResumeMeeting = null,
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
  /** `place` is where the form put it: `folder` unless somebody picked another. */
  onCreateFolder: (name: string, place: string) => void;
  /** Every folder the New folder form's place picker offers. */
  folders?: readonly string[];
  /** What the top of the workspace is called in the place picker. */
  rootLabel?: string;
  /**
   * `null` on a surface with no meeting flow behind it — the fixtures and the
   * landing page's demo console. Absent rather than pressable and inert, which
   * is the contract `onNewChat` keeps below and `CreateButton` keeps for both.
   */
  onNewMeeting: (() => void) | null;
  /** `null` with no engine behind it, or no model key connected. */
  onNewChat: (() => void) | null;
  /**
   * Carry on a meeting that already has a note — `CreateButton`'s `resume`,
   * with the same detail under it. `null` when there is none to carry on, and
   * then the row is not drawn.
   */
  onResumeMeeting?: { detail: string; onResume: () => void } | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [naming, setNaming] = useState(false);

  if (naming) {
    return (
      <NewFolderForm
        folder={folder}
        folders={folders}
        rootLabel={rootLabel}
        onCancel={onCancel}
        onCreate={(place, name) => onCreateFolder(name, place)}
      />
    );
  }

  return (
    <Shell title="Create" onClose={onCancel} sheet>
      <Text variant="paneSub">
        {`In ${whereIn(folder)}.`}
      </Text>
      <View style={styles.choices}>
        {createRows({
          canEdit,
          chat: onNewChat !== null,
          meeting: onNewMeeting !== null,
          resume: onResumeMeeting !== null,
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
              if (row === "resume-meeting") onResumeMeeting?.onResume();
            }}
            style={styles.choiceRow}
            hoverStyle={styles.listRowHover}
            testID={`create-row-${row}`}
          >
            <Text variant="body">{ROW_TITLES[row]}</Text>
            <Text variant="paneSub">
              {row === "resume-meeting" && onResumeMeeting !== null
                ? onResumeMeeting.detail
                : ROW_SUBS[row]}
            </Text>
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
  "resume-meeting": "Resume meeting",
  "new-meeting": "New meeting",
  "new-note": "New note",
  "new-drawing": "New drawing",
  "new-folder": "New folder",
  "new-chat": "New chat",
};

/** The word on the row. Shorter than the label: the sheet has a title. */
const ROW_TITLES: Record<CreateRow, string> = {
  "resume-meeting": "Resume meeting",
  "new-meeting": "Meeting",
  "new-note": "Note",
  "new-drawing": "Drawing",
  "new-folder": "Folder",
  "new-chat": "Chat",
};

/** What each row does. Resume's names the meeting, so it is passed in. */
const ROW_SUBS: Record<CreateRow, string> = {
  "resume-meeting": "Carries on the meeting you last recorded.",
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
  placeholder = "name",
  onCancel,
  onConfirm,
}: {
  title: string;
  description?: string;
  /** What the empty field says to type. */
  placeholder?: string;
  confirmLabel: string;
  initialValue?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const [value, setValue] = useState(initialValue);
  const [focused, setFocused] = useState(false);
  const problem = value.trim() === "" ? null : describeNameProblem(value);
  const ready = value.trim() !== "" && problem === null;
  // A phone asks from the bottom of the glass, as its + sheet does (boards 05 and 11).
  const sheet = densityFor(useWindowDimensions().width) === "compact";

  return (
    <Shell title={title} onClose={onCancel} sheet={sheet}>
      {description ? <Text variant="paneSub">{description}</Text> : null}
      <TextInput
        value={value}
        onChangeText={setValue}
        autoFocus
        style={[styles.input, focused && styles.inputFocused, fieldFont]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
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
 * A narrowing `typeof x === "object"` cannot do on its own.
 *
 * `typeof null` is `"object"`, so the obvious check reads `null` — this
 * context, the case with no remote list at all — as a loaded one.
 */
function isFolderList(value: FolderLoad | null): value is Exclude<FolderLoad, string> {
  return value !== null && typeof value === "object";
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
export function MovePicker({
  title,
  description,
  folders,
  currentFolder,
  destinations = [],
  loadDestinationFolders,
  rootLabel = "Your workspace",
  onCancel,
  onConfirm,
}: {
  title: string;
  /** What the top of this workspace is called on a phone, where places are named rather than pathed. */
  rootLabel?: string;
  /** A consequence worth reading before choosing — see `sharesBreakingWarning`. */
  description?: string;
  folders: readonly string[];
  /**
   * Where the thing is now, marked and not choosable. `null` for a batch whose
   * items are in different folders, where no one folder is "where it is now".
   */
  currentFolder: string | null;
  /**
   * Other contexts this can go to. Empty is the ordinary case — one context,
   * or somebody who does not own this one — and the row of context buttons is
   * then absent rather than a single disabled option.
   */
  destinations?: readonly MoveDestination[];
  /**
   * Fetches the folders directly inside one folder of a destination: its top
   * level when it is chosen, and each folder as it is opened.
   */
  loadDestinationFolders?: (contextId: string, folder: string) => Promise<{
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
  const remote = useDestinationFolders(loadDestinationFolders);

  const pick = (contextId: string | null) => {
    setContext(contextId);
    // The chosen folder belongs to the context it was chosen in. Keeping it
    // across a switch would arm "Move here" with a path the other context may
    // not even have.
    setChosen(null);
    if (contextId !== null) remote.open(contextId, "");
  };

  const there = useMemo(() => remote.view(context), [remote, context]);
  const loaded = context === null ? null : (there.top ?? "loading");
  const elsewhere = destinations.find((one) => one.id === context) ?? null;
  const sheet = densityFor(useWindowDimensions().width) === "compact";

  return (
    <Shell title={title} onClose={onCancel} sheet={sheet}>
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
      {there.truncated ? (
        <Text variant="paneSub">Some of that context&apos;s folders are too big to list in full.</Text>
      ) : null}
      {sheet ? (
        /*
          A phone's Move is board 12: the place picker New folder uses, folders
          by name with the workspace at the top, rather than the pointer
          layout's list of raw paths. Keyed by context so a switch starts the
          tree over in that context's folders.
        */
        <PlacePicker
          key={context ?? ""}
          folders={context === null ? folders : there.folders}
          unexplored={context === null ? undefined : there.unexplored}
          loading={context === null ? undefined : there.loading}
          onOpen={context === null ? undefined : (folder) => remote.open(context, folder)}
          rootLabel={elsewhere?.label ?? rootLabel}
          initial={context === null ? (currentFolder ?? "") : ""}
          here={context === null ? currentFolder : null}
          backLabel="Cancel"
          onBack={onCancel}
          confirmLabel={(name) => `Move to ${name}`}
          onPick={(folder) => onConfirm(folder, context)}
        />
      ) : (
        <>
          {elsewhere !== null ? (
            /*
              Keyed by context for the reason the phone's picker is: a switch
              starts the tree over, closed, in that context's folders.
            */
            isFolderList(loaded) ? (
              <DestinationTree
                key={elsewhere.id}
                label={elsewhere.label}
                view={there}
                chosen={chosen}
                onChoose={setChosen}
                onOpen={(folder) => remote.open(elsewhere.id, folder)}
              />
            ) : null
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {folders.map((folder) => {
                const here = folder === currentFolder;
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
          )}
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
        </>
      )}
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
    // Its own petrol border when focused, not the browser's orange outline (board 05).
    outlineWidth: 0,
  },
  inputFocused: { borderColor: colors.accent },
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

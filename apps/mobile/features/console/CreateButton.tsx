import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { floatingStackBottom, useBottomChromeHeight } from "../app/bottomChrome";
import { registerCornerControl } from "../app/cornerControl";
import { Icon } from "../design/components/Icon";
import { CreateChoices } from "./CreateChoices";
import type { CreateRow } from "./files/createSheet";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import type { UsageButton } from "@context/shared";
import { trackButton } from "../observability/client";

/**
 * The + in the corner of the console, and the three things it makes.
 *
 * ## It replaced a microphone, and the replacement is the point
 *
 * The corner held `VoiceButton`: a microphone that raised a sheet offering
 * dictation, a meeting and the agent. Two things were wrong with it, and the
 * owner named both. It was **a microphone**, which is one of the things you
 * might want to start and not the common one — *"we need to get rid of the
 * microphone button bottom right and instead it should be a + button"*. And it
 * was drawn **only over a live editor**, so the control vanished on a folder
 * page, on the map and on search — *"it should show up all the time, even when
 * on a folder page, and not just show up when on a note"*.
 *
 * So this is mounted by the console layout rather than by the note editor, and
 * that is the whole of the second fix: the layout is on screen for every route
 * inside `/console`, and the editor is not. Nothing here asks what is open.
 *
 * ## A recording and four files
 *
 * A meeting, a note, a table, a drawing, a folder: the things somebody starts
 * from a console that is otherwise all *opening* things that already exist.
 * The card draws them as one wide Record a meeting button and four one-word
 * tiles (`CreateChoices`, shared with the phone's sheet), because the five
 * rows of a label and a sentence each read as wordy (Dev, 2026-11-24).
 * Dictation is not on it: it needs a caret to type into, so it lives where the
 * caret is (the note's own menu). `VoiceButton` still owns it, and still owns
 * the live capsule and the failure card, which are the only way to stop a run.
 *
 * ## Not on a phone
 *
 * `compact` draws the bottom row, whose own `+` raises the same five rows as a
 * sheet (`CreatePrompt`) at thumb height. A second floating control 24pt above
 * that row is the defect `oneMicrophone.test.ts` exists for, arriving again with
 * a different glyph on it.
 */
export function CreateButton({
  compact,
  onNewMeeting,
  onNewNote,
  onNewDrawing,
  onNewSheet,
  onNewFolder,
  folder,
  resume = null,
  bottomInset = 0,
  beside = null,
}: {
  /** The phone's bottom row is on screen; this stands down. See the header. */
  compact: boolean;
  onNewMeeting: () => void;
  onNewNote: () => void;
  onNewDrawing: () => void;
  onNewSheet: () => void;
  onNewFolder: () => void;
  /** Where a note, table, drawing or folder made from here lands; `""` is the top. */
  folder?: string;
  /**
   * Carry on recording a meeting that already has a note, or `null` when there
   * is none to carry on.
   *
   * Offered here because this is the moment it is for: somebody about to press
   * New meeting for a meeting that stopped a minute ago gets a second note, and
   * the row that prevents it sits one above that press. At any other time it is
   * not drawn at all, so it never needs dismissing. `resumeRowFor` decides which
   * meeting, and the detail says which.
   */
  resume?: { detail: string; onResume: () => void } | null;
  /**
   * The safe area under this edge, as `VoiceButton` took it and for the same
   * reason: `useSafeAreaInsets` throws outside a `SafeAreaProvider`, and this
   * is mounted by surfaces that render without one. Zero is right for a browser.
   */
  bottomInset?: number;
  /**
   * Drawn to the left of the button, on its line: the next meeting on the
   * calendar (`NextUpPill`), the thing the `+` would start next.
   */
  beside?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  /*
    Stacked above whatever is already floating at this edge, exactly as the
    microphone was and through the same two functions — a floating control over
    somebody else's floating control is a control that eats their presses.
  */
  const bottom = floatingStackBottom(bottomInset, useBottomChromeHeight());
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<View>(null);
  const panelRef = useRef<View>(null);

  /**
   * The panel is drawn in this dock, directly above the button, rather than
   * portalled to an anchor the way `Menu` is: the dock is already pinned to
   * the corner, so the panel's right edge is the button's and its bottom is
   * the dock's gap above it with nothing measured. That is what the anchor measuring
   * this replaced was for, and it could not land wrong under jsdom either.
   */
  const press = useCallback(() => setOpen((was) => !was), []);
  const dismiss = useCallback(() => setOpen(false), []);

  /*
    A popover's two exits: Escape, and a press anywhere outside it. The `+`
    itself is outside the panel and toggles, so its press is left to it.
  */
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const contains = (ref: { current: unknown }, target: Node) =>
      (ref.current as { contains?: (node: Node) => boolean } | null)?.contains?.(target) === true;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target === null || contains(panelRef, target) || contains(buttonRef, target)) return;
      dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [dismiss, open]);

  // So a card floating beside this corner can line up with it. See `cornerControl.ts`.
  useEffect(
    () =>
      compact
        ? undefined
        : registerCornerControl((answer) =>
            buttonRef.current?.measureInWindow((x, y, width, height) => answer({ x, y, width, height })),
          ),
    [compact],
  );

  const choose = useCallback(
    (id: string) => {
      setOpen(false);
      const button = CREATE_BUTTONS[id];
      if (button !== undefined) trackButton(button);
      if (id === "resume-meeting") resume?.onResume();
      if (id === "new-meeting") onNewMeeting();
      if (id === "new-note") onNewNote();
      if (id === "new-drawing") onNewDrawing();
      if (id === "new-sheet") onNewSheet();
      if (id === "new-folder") onNewFolder();
    },
    [onNewDrawing, onNewFolder, onNewMeeting, onNewNote, onNewSheet, resume],
  );

  if (compact) return null;

  return (
    <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
      {!open ? null : (
        <View
          ref={panelRef}
          role="menu"
          aria-label="Create"
          testID="console-create-menu"
          style={styles.panel}
        >
          <CreateChoices
            rows={[...(resume === null ? [] : ["resume-meeting" as const]), ...ROWS]}
            {...(folder === undefined ? {} : { folder })}
            {...(resume === null ? {} : { resumeDetail: resume.detail })}
            touch={false}
            onChoose={choose}
          />
        </View>
      )}
      <View style={styles.line}>
        {beside}
        <Pressable
          ref={buttonRef}
          onPress={press}
          role="button"
          accessibilityLabel="Create"
          aria-haspopup="menu"
          aria-expanded={open}
          testID="console-create"
          style={({ pressed }) => [styles.fab, (pressed || open) && styles.fabActive]}
        >
          <Icon name="plus" size={23} color={open ? colors.ink : colors.accent} />
        </Pressable>
      </View>

    </View>
  );
}

/** The menu's rows the Usage tab counts, by its fixed names. */
const CREATE_BUTTONS: Partial<Record<string, UsageButton>> = {
  "new-meeting": "new_meeting",
  "new-note": "new_note",
  "new-drawing": "new_drawing",
  "new-folder": "new_folder",
};

/** The rows the corner always offers; Resume joins them when there is a meeting to carry on. */
const ROWS: CreateRow[] = ["new-meeting", "new-note", "new-sheet", "new-drawing", "new-folder"];

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    /*
      Anchored to the region rather than to the document, exactly as the
      microphone was: inside a scroller's content it would ride the document
      and leave the corner empty halfway down a long note.
    */
    dock: {
      position: "absolute",
      right: 24,
      alignItems: "flex-end",
      gap: 10,
      zIndex: 5,
    },
    line: { flexDirection: "row", alignItems: "center", gap: 12, pointerEvents: "box-none" },
    fab: {
      width: 56,
      height: 56,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hintBorder,
      boxShadow: shadows.floating,
      cursor: "pointer",
    },
    fabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    // The dock's gap is the air between this and the button.
    panel: {
      width: 312,
      padding: 10,
      borderRadius: radii.console,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      boxShadow: shadows.floating,
    },
  });

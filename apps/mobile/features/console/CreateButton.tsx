import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { floatingStackBottom, useBottomChromeHeight } from "../app/bottomChrome";
import { Icon } from "../design/components/Icon";
import { Menu } from "../design/components/Menu";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";

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
 * ## Three items, and no fourth
 *
 * A meeting, a note, a chat — the three things somebody starts from a console
 * that is otherwise all *opening* things that already exist. Dictation is not a
 * fourth: it needs a caret to type into, so it lives where the caret is (the
 * note's own menu) rather than in a corner that is drawn over folders and maps.
 * `VoiceButton` still owns it, and still owns the live capsule and the failure
 * card, which are the only way to stop a run.
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
  onNewFolder,
  onNewChat,
  bottomInset = 0,
}: {
  /** The phone's bottom row is on screen; this stands down. See the header. */
  compact: boolean;
  onNewMeeting: () => void;
  onNewNote: () => void;
  onNewDrawing: () => void;
  onNewFolder: () => void;
  /**
   * Start a conversation, or `null` where one cannot be had.
   *
   * Two reasons it is `null`: no engine behind it (the demo console), and **no
   * model key on this context**. A key is what makes the agent able to answer at
   * all, so offering the row without one is an offer that opens a composer and
   * errors on the first send — the shape this repo refuses everywhere else as "a
   * control that appears to work and does nothing".
   *
   * It used to be three, and *"no panel to answer in (a phone)"* was the third.
   * That was a fact about the code rather than a decision, and it is gone: a
   * phone raises `AgentPanel` — a `Modal`, by its own header's argument — from
   * the `+` sheet instead of a panel. This component is not drawn at `compact`
   * at all, so the sentence was never about *this* control; it was about the
   * value the layout passes, and it made the phone's sheet drop the row.
   *
   * The console reads it from `ConsoleData.modelConnected`, which is
   * `undefined` until the subscription answers: absent, then present, rather
   * than present, then taken away.
   */
  onNewChat: (() => void) | null;
  /**
   * The safe area under this edge, as `VoiceButton` took it and for the same
   * reason: `useSafeAreaInsets` throws outside a `SafeAreaProvider`, and this
   * is mounted by surfaces that render without one. Zero is right for a browser.
   */
  bottomInset?: number;
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
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  const buttonRef = useRef<View>(null);

  /**
   * The button's own top-right corner, not the point the pointer landed on.
   *
   * **This was `event.nativeEvent.pageX/pageY`, and the browser showed what
   * that costs.** `place()` puts a popover's top-left at the anchor and flips
   * rather than clips — so anchored at a press inside a 56pt button sitting
   * against the bottom-right of the window, the menu flipped to *end* at the
   * pointer: its lower half lay across the top half of the `+`, with the
   * button drawn over it. Nothing measured that; a screenshot of the running
   * board did.
   *
   * Anchoring on the trigger instead makes both flips land where the design
   * draws them: the right edge flush with the button's, and the bottom edge
   * `GAP` above it. `measureInWindow` at press time rather than a value kept
   * from layout, exactly as `AccountBlock`'s menu trigger does it — anything
   * that scrolls under a control makes a remembered position a stale one.
   *
   * Touch never reads it: `Menu` draws a sheet from the bottom edge there.
   *
   * **The menu opens outside the measurement, not inside its callback.**
   * `measureInWindow` is the host's, it answers asynchronously, and under
   * jsdom it never answers at all — so a version that opened the menu in the
   * callback was a button that did nothing wherever the measurement did not
   * land. `AccountBlock`'s trigger is written this way for the same reason:
   * the anchor is a *hint*, and `Menu` falls back to its own margin without
   * one.
   */
  const press = useCallback(() => {
    buttonRef.current?.measureInWindow((x, y, width) => {
      setAnchor({ x: x + width, y: y - GAP });
    });
    setOpen(true);
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
    setAnchor(undefined);
  }, []);

  const choose = useCallback(
    (id: string) => {
      setOpen(false);
      setAnchor(undefined);
      if (id === "new-meeting") onNewMeeting();
      if (id === "new-note") onNewNote();
      if (id === "new-drawing") onNewDrawing();
      if (id === "new-folder") onNewFolder();
      if (id === "new-chat") onNewChat?.();
    },
    [onNewChat, onNewDrawing, onNewFolder, onNewMeeting, onNewNote],
  );

  if (compact) return null;

  return (
    <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
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

      {!open ? null : (
        <Menu<string>
          {...(anchor === undefined ? {} : { anchor })}
          title="Create"
          items={[
            {
              id: "new-meeting",
              label: "New meeting",
              /*
                The detail says where it lands, because nothing else will: the
                press records, and the destination sheet that used to name a
                folder is gone. See `useMeetingFlow`.
              */
              detail: "Records into your inbox, in the panel.",
            },
            /*
              The three things that end up as files, grouped behind a rule:
              they share a destination — the folder you have selected — and
              they share a dialog, which is the naming prompt the tree's own
              `+` raises. A meeting is above them because it starts a
              *recording* rather than a file, and a conversation is below
              because it makes nothing at all.
            */
            {
              id: "new-note",
              label: "New note",
              detail: "In the folder you have selected.",
              separatorBefore: true,
            },
            { id: "new-drawing", label: "New drawing", detail: "An Excalidraw canvas." },
            { id: "new-folder", label: "New folder" },
            ...(onNewChat === null
              ? []
              : [
                  {
                    id: "new-chat",
                    label: "New chat",
                    detail: "Ask about this note, or your whole context.",
                    separatorBefore: true,
                  },
                ]),
          ]}
          onSelect={choose}
          onDismiss={dismiss}
        />
      )}
    </View>
  );
}

/** Air between the button and the menu it opens. `layout.floatingInset`'s. */
const GAP = 12;

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
  });

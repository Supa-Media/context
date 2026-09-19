import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";

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
 * `compact` draws the seven-key bottom row, which already carries New note and
 * the meetings key at thumb height. A floating control 24pt above that row is
 * the defect `oneMicrophone.test.ts` exists for, arriving again with a
 * different glyph on it.
 */
export function CreateButton({
  compact,
  onNewMeeting,
  onNewNote,
  onNewChat,
  bottomInset = 0,
}: {
  /** The phone's bottom row is on screen; this stands down. See the header. */
  compact: boolean;
  onNewMeeting: () => void;
  onNewNote: () => void;
  /** `null` where there is no panel for a conversation to open in. */
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
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const open = useCallback((event: GestureResponderEvent) => {
    /*
      Where the press landed, which is what the web menu anchors its popover to
      — the same handoff the file tree's right-click makes. On touch the anchor
      is ignored and the sheet comes from the bottom edge, so a missing
      `pageX`/`pageY` costs nothing: `Menu` falls back to its own margin.
    */
    const { pageX, pageY } = event.nativeEvent;
    setAnchor({ x: pageX, y: pageY });
  }, []);

  const dismiss = useCallback(() => setAnchor(null), []);

  const choose = useCallback(
    (id: string) => {
      setAnchor(null);
      if (id === "new-meeting") onNewMeeting();
      if (id === "new-note") onNewNote();
      if (id === "new-chat") onNewChat?.();
    },
    [onNewChat, onNewMeeting, onNewNote],
  );

  if (compact) return null;

  return (
    <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
      <Pressable
        onPress={open}
        role="button"
        accessibilityLabel="Create"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        testID="console-create"
        style={({ pressed }) => [styles.fab, (pressed || anchor !== null) && styles.fabActive]}
      >
        <Icon name="plus" size={23} color={anchor !== null ? colors.ink : colors.accent} />
      </Pressable>

      {anchor === null ? null : (
        <Menu<string>
          anchor={anchor}
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
            { id: "new-note", label: "New note", detail: "In the folder you have selected." },
            ...(onNewChat === null
              ? []
              : [
                  {
                    id: "new-chat",
                    label: "New chat",
                    detail: "Ask about this note, or your whole context.",
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

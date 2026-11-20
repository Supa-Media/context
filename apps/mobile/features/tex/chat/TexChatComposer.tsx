import { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useFieldFont } from "../../design/fieldFont";
import { pointerType, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useHoverTitle } from "../../design/useHoverTitle";
import { MAX_PICTURES, MAX_TEXT } from "./appChatGateway";

/** What the reply bar names: who the row is from, and its first line of words. */
export interface ReplyTarget {
  id: string;
  who: "me" | "tex";
  text: string;
}

/** The row being edited: its id, and the words that go into the box. */
export interface EditTarget {
  id: string;
  text: string;
}

interface Picture {
  key: string;
  file: Blob;
  url: string | null;
}

let pictureSeq = 0;

/** One line of the box: 20.3 px of words and 5 px above and below. */
const INPUT_MIN = 31;
/** The tallest the box grows before it scrolls. */
const INPUT_MAX = 120;

/** An object URL for a picture the person picked, or `null` where this surface cannot make one. */
function previewOf(file: Blob): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(file);
}

function forget(picture: Picture): void {
  if (picture.url !== null && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(picture.url);
  }
}

/** The first line of a row's words, cut short, for the reply bar. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim().length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Asks the browser for images. A hidden file input, opened from the picture
 * button; nothing here runs on a surface with no document.
 */
function chooseImages(limit: number, onChosen: (files: Blob[]) => void): void {
  if (typeof document === "undefined") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])].filter((file) => file.type.startsWith("image/")).slice(0, limit);
    if (files.length > 0) onChosen(files);
  };
  input.click();
}

/**
 * The box at the foot of the chat: words, up to `MAX_PICTURES` pictures, the
 * reply or edit it is about, and the send.
 *
 * Enter sends; Shift+Enter is a newline. It owns the draft and the pictures
 * and hands them to `onSend` whole. The hook decides whether it went.
 *
 * In `mode="stop"` with the box empty, the send key becomes a stop key that
 * calls `onStop` (Tex is working on a turn).
 */
export function TexChatComposer({
  sending,
  disabled,
  reply,
  edit,
  mode = "send",
  onCancelReply,
  onCancelEdit,
  onSend,
  onStop,
  onTyping,
}: {
  sending: boolean;
  disabled: boolean;
  reply: ReplyTarget | null;
  edit: EditTarget | null;
  /** `stop` shows the send key as a stop key while the box is empty. */
  mode?: "send" | "stop";
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (text: string, pictures: Blob[]) => void;
  /** Pressed in stop mode with an empty box. */
  onStop?: () => void;
  /** The person typed in the box: the chat warms the model's cache for their text (`useAppChat` `typing`). */
  onTyping?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.lede);
  const colors = useColors();
  const [text, setText] = useState("");
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [attachHover, setAttachHover] = useState(false);
  // The box grows with its words, one line to start (a web textarea is two rows tall by default), up to 120 px.
  const [inputHeight, setInputHeight] = useState(INPUT_MIN);
  const attachRef = useRef<View>(null);
  useHoverTitle(attachRef, "Attach a picture or file");
  const picturesNow = useRef<Picture[]>([]);
  picturesNow.current = pictures;

  // An edit puts its row's words in the box; leaving the edit empties it.
  const editId = edit?.id ?? null;
  const editText = edit?.text ?? "";
  useEffect(() => {
    setText(editText);
    setPictures((old) => {
      old.forEach(forget);
      return [];
    });
    // Keyed on the row, not its words: typing does not reset the box.
  }, [editId]);

  // Object URLs are released when the composer goes.
  useEffect(
    () => () => {
      picturesNow.current.forEach(forget);
    },
    [],
  );

  const editing = edit !== null;
  const room = Math.max(0, MAX_PICTURES - pictures.length);
  const hasWords = text.trim().length > 0;
  const hasPictures = pictures.length > 0;
  const canSend = !disabled && !sending && (editing ? hasWords : hasWords || hasPictures) && text.trim().length <= MAX_TEXT;
  const stopping = mode === "stop" && !editing && !hasWords && !hasPictures;
  const buttonEnabled = stopping || canSend;

  const submit = () => {
    if (!canSend) return;
    const words = text.trim();
    const files = editing ? [] : pictures.map((picture) => picture.file);
    onSend(words, files);
    if (!editing) {
      pictures.forEach(forget);
      setPictures([]);
    }
    setText("");
  };

  const press = () => {
    if (stopping) {
      onStop?.();
      return;
    }
    submit();
  };

  const addPictures = (files: Blob[]) => {
    const next = files.slice(0, room).map((file) => {
      pictureSeq += 1;
      return { key: `pic-${pictureSeq}`, file, url: previewOf(file) };
    });
    setPictures((old) => [...old, ...next]);
  };

  const removePicture = (key: string) => {
    setPictures((old) => {
      const gone = old.find((picture) => picture.key === key);
      if (gone !== undefined) forget(gone);
      return old.filter((picture) => picture.key !== key);
    });
  };

  const replying = reply !== null;
  const attached = replying || editing;

  return (
    <View style={styles.composer} testID="tex-composer">
      {hasPictures ? (
        <View style={styles.thumbs} testID="tex-thumbs">
          {pictures.map((picture, index) => (
            <View key={picture.key} style={styles.thumb}>
              {picture.url !== null ? (
                <Image source={{ uri: picture.url }} style={styles.thumbImage} resizeMode="cover" accessibilityLabel={`Picture ${index + 1}`} />
              ) : (
                <View style={[styles.thumbImage, styles.thumbPlaceholder]} />
              )}
              <Pressable
                onPress={() => removePicture(picture.key)}
                accessibilityRole="button"
                accessibilityLabel={`Remove picture ${index + 1}`}
                style={styles.thumbRemove}
                testID={`tex-remove-${index}`}
              >
                <Icon name="close" size={10} color={colors.text} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {reply !== null ? (
        <Chip
          testID="tex-reply-bar"
          icon="arrowLeft"
          label={`${reply.who === "me" ? "Replying to yourself" : "Replying to Tex"}: ${firstLine(reply.text) || "a message"}`}
          cancelLabel="Cancel reply"
          cancelTestID="tex-reply-cancel"
          onCancel={onCancelReply}
          styles={styles}
          colors={colors}
        />
      ) : null}

      {editing ? (
        <Chip
          testID="tex-edit-bar"
          icon="pencil"
          label="Editing your text"
          cancelLabel="Cancel edit"
          cancelTestID="tex-edit-cancel"
          onCancel={onCancelEdit}
          styles={styles}
          colors={colors}
        />
      ) : null}

      <View style={[styles.box, attached && styles.boxAttached]}>
        {editing ? null : (
          <Pressable
            ref={attachRef}
            onPress={() => chooseImages(room, addPictures)}
            onHoverIn={() => setAttachHover(true)}
            onHoverOut={() => setAttachHover(false)}
            disabled={room === 0 || disabled}
            accessibilityRole="button"
            accessibilityLabel="Attach"
            style={[styles.iconButton, attachHover && room > 0 && styles.iconButtonHover, (room === 0 || disabled) && styles.disabled]}
            testID="tex-picture"
          >
            <Icon name="attach" size={17} color={colors.muted} />
          </Pressable>
        )}
        <TextInput
          value={text}
          onChangeText={(next) => {
            setText(next);
            if (next.trim() !== "") onTyping?.();
          }}
          placeholder="Ask Tex, or tell it what to do"
          placeholderTextColor={colors.muted}
          multiline
          numberOfLines={1}
          onContentSizeChange={(event) => {
            const grown = Math.ceil(event.nativeEvent.contentSize.height);
            setInputHeight(Math.min(INPUT_MAX, Math.max(INPUT_MIN, grown)));
          }}
          editable={!disabled}
          onKeyPress={(event) => {
            const native = event.nativeEvent as { key?: string; shiftKey?: boolean; preventDefault?: () => void };
            if (native.key === "Enter" && native.shiftKey !== true) {
              native.preventDefault?.();
              submit();
            }
          }}
          accessibilityLabel="Message to Tex"
          style={[styles.input, fieldFont, { height: text === "" ? INPUT_MIN : inputHeight }]}
          testID="tex-input"
        />
        <Pressable
          onPress={press}
          disabled={!buttonEnabled}
          accessibilityRole="button"
          accessibilityLabel={stopping ? "Stop Tex" : editing ? "Save edit" : "Send"}
          accessibilityState={{ disabled: !buttonEnabled }}
          style={({ pressed }) => [
            stopping ? styles.stop : styles.send,
            !buttonEnabled && styles.sendDisabled,
            pressed && buttonEnabled && styles.pressed,
          ]}
          testID="tex-send"
        >
          {stopping ? (
            <Icon name="stop" size={20} color={colors.ground} />
          ) : (
            <Icon name="arrowUp" size={16} color={colors.ink} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

/** The chip on the top of the box: what the box is about, and a close key. */
function Chip({
  testID,
  icon,
  label,
  cancelLabel,
  cancelTestID,
  onCancel,
  styles,
  colors,
}: {
  testID: string;
  icon: IconName;
  label: string;
  cancelLabel: string;
  cancelTestID: string;
  onCancel: () => void;
  styles: Styles;
  colors: Colors;
}) {
  return (
    <View style={styles.chip} testID={testID}>
      <Icon name={icon} size={13} color={colors.muted} />
      <Text variant="meta" style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
      <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel={cancelLabel} style={styles.close} testID={cancelTestID}>
        <Icon name="close" size={13} color={colors.muted} />
      </Pressable>
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    composer: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: 12 },
    thumbs: { flexDirection: "row", flexWrap: "wrap", gap: space.x2, marginBottom: 8 },
    thumb: { width: 56, height: 56 },
    thumbImage: { width: 56, height: 56, borderRadius: radii.xs, backgroundColor: colors.chrome },
    thumbPlaceholder: { backgroundColor: colors.chromePressed },
    thumbRemove: {
      position: "absolute",
      top: -6,
      right: -6,
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 6,
      paddingLeft: 10,
      paddingRight: 4,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: colors.line,
      borderTopLeftRadius: 9,
      borderTopRightRadius: 9,
      backgroundColor: colors.surface3,
    },
    chipText: { flex: 1, minWidth: 0, fontSize: 12, color: colors.muted },
    close: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.control,
    },
    box: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 6,
      paddingTop: 6,
      paddingBottom: 6,
      paddingLeft: 10,
      paddingRight: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 14,
      backgroundColor: colors.ground,
    },
    boxAttached: { borderTopLeftRadius: 0, borderTopRightRadius: 0 },
    iconButton: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 16,
    },
    iconButtonHover: { backgroundColor: colors.surface3 },
    input: {
      flex: 1,
      minWidth: 0,
      maxHeight: 120,
      paddingVertical: 5,
      borderWidth: 0,
      backgroundColor: "transparent",
      color: colors.text,
      fontSize: 14.5,
      lineHeight: 20.3,
      textAlignVertical: "top",
    },
    send: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 16,
      backgroundColor: colors.accent,
    },
    stop: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 16,
      backgroundColor: colors.text,
    },
    sendDisabled: { opacity: 0.35 },
    pressed: { transform: [{ scale: 0.9 }] },
    disabled: { opacity: 0.45 },
  });

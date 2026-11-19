import { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
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
 */
export function TexChatComposer({
  sending,
  disabled,
  reply,
  edit,
  onCancelReply,
  onCancelEdit,
  onSend,
}: {
  sending: boolean;
  disabled: boolean;
  reply: ReplyTarget | null;
  edit: EditTarget | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (text: string, pictures: Blob[]) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [text, setText] = useState("");
  const [pictures, setPictures] = useState<Picture[]>([]);
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

  return (
    <View style={styles.composer} testID="tex-composer">
      {reply !== null ? (
        <View style={styles.bar} testID="tex-reply-bar">
          <View style={styles.barWords}>
            <Text variant="meta" style={styles.barTitle}>
              {reply.who === "me" ? "Replying to yourself" : "Replying to Tex"}
            </Text>
            <Text variant="meta" style={styles.barSub} numberOfLines={1}>
              {firstLine(reply.text) || "a message"}
            </Text>
          </View>
          <Pressable onPress={onCancelReply} accessibilityRole="button" accessibilityLabel="Cancel reply" style={styles.close} testID="tex-reply-cancel">
            <Icon name="close" size={14} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      {editing ? (
        <View style={styles.bar} testID="tex-edit-bar">
          <Text variant="meta" style={styles.barTitle}>
            Editing message
          </Text>
          <Pressable onPress={onCancelEdit} accessibilityRole="button" accessibilityLabel="Cancel edit" style={styles.close} testID="tex-edit-cancel">
            <Icon name="close" size={14} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

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

      <View style={styles.row}>
        {editing ? null : (
          <Pressable
            onPress={() => chooseImages(room, addPictures)}
            disabled={room === 0 || disabled}
            accessibilityRole="button"
            accessibilityLabel="Add pictures"
            style={[styles.iconButton, (room === 0 || disabled) && styles.disabled]}
            testID="tex-picture"
          >
            <Icon name="attach" size={16} color={colors.text2} />
          </Pressable>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Ask Tex, or tell it what to do"
          placeholderTextColor={colors.muted}
          multiline
          editable={!disabled}
          onKeyPress={(event) => {
            const native = event.nativeEvent as { key?: string; shiftKey?: boolean; preventDefault?: () => void };
            if (native.key === "Enter" && native.shiftKey !== true) {
              native.preventDefault?.();
              submit();
            }
          }}
          accessibilityLabel="Message to Tex"
          style={styles.input}
          testID="tex-input"
        />
        <Pressable
          onPress={submit}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel={editing ? "Save edit" : "Send"}
          accessibilityState={{ disabled: !canSend }}
          style={[styles.send, !canSend && styles.disabled]}
          testID="tex-send"
        >
          <Text variant="meta" style={styles.sendLabel}>
            {editing ? "Save" : "Send"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    composer: {
      gap: space.x2,
      padding: space.x3,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingLeft: space.x3,
      paddingRight: space.x1,
      paddingVertical: space.x1,
      borderLeftWidth: 2,
      borderLeftColor: colors.accent,
      backgroundColor: colors.chrome,
      borderRadius: radii.xs,
    },
    barWords: { flex: 1, minWidth: 0 },
    barTitle: { color: colors.text },
    barSub: { color: colors.muted },
    close: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.control,
    },
    thumbs: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
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
    row: { flexDirection: "row", alignItems: "flex-end", gap: space.x2 },
    iconButton: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.control,
    },
    input: {
      flex: 1,
      minWidth: 0,
      minHeight: 36,
      maxHeight: 140,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      borderRadius: radii.xs,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
      color: colors.text,
      fontSize: 14,
      lineHeight: 20,
      textAlignVertical: "top",
    },
    send: {
      minHeight: 36,
      minWidth: 36,
      paddingHorizontal: space.x3,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.control,
      backgroundColor: colors.accent,
    },
    sendLabel: { color: colors.ink },
    disabled: { opacity: 0.45 },
  });

import { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useFieldFont } from "../../design/fieldFont";
import { pointerType, radii, space, texChatType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useHoverTitle } from "../../design/useHoverTitle";
import { MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_TEXT } from "./appChatGateway";
import type { PickedFile } from "./appChatFiles";
import { TexChatFileChip } from "./TexChatFileChip";

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

/** What the picker offers: pictures, PDFs and the plain text formats. */
const PICK_ACCEPT = "image/*,application/pdf,.pdf,.txt,.md,.csv,.tsv,.json,.docx";
/**
 * The file names the route keeps (`packages/tex/worker/appFiles.ts`). A picker's accept list is only a hint, and one
 * file it would refuse fails the whole send, so anything else is left out here.
 */
const KEPT_FILE = /\.(?:pdf|txt|md|csv|tsv|json|docx)$/i;

/**
 * Asks the browser for pictures and files. A hidden file input, opened from the
 * attach button; nothing here runs on a surface with no document.
 */
function chooseFiles(onChosen: (files: PickedFile[]) => void): void {
  if (typeof document === "undefined") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = PICK_ACCEPT;
  input.multiple = true;
  input.onchange = () => {
    const picked = [...(input.files ?? [])];
    if (picked.length > 0) onChosen(picked);
  };
  input.click();
}

/**
 * The box at the foot of the chat: words, up to `MAX_ATTACHMENTS` pictures and
 * files, the reply or edit it is about, and the send.
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
  onSend: (text: string, pictures: Blob[], files: PickedFile[]) => void;
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
  const [files, setFiles] = useState<PickedFile[]>([]);
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
    setFiles([]);
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
  const room = Math.max(0, MAX_ATTACHMENTS - pictures.length - files.length);
  const hasWords = text.trim().length > 0;
  const hasPictures = pictures.length > 0;
  const hasFiles = files.length > 0;
  const hasAttachments = hasPictures || hasFiles;
  const canSend = !disabled && !sending && (editing ? hasWords : hasWords || hasAttachments) && text.trim().length <= MAX_TEXT;
  const stopping = mode === "stop" && !editing && !hasWords && !hasAttachments;
  const buttonEnabled = stopping || canSend;

  const submit = () => {
    if (!canSend) return;
    const words = text.trim();
    onSend(
      words,
      editing ? [] : pictures.map((picture) => picture.file),
      editing ? [] : files,
    );
    if (!editing) {
      pictures.forEach(forget);
      setPictures([]);
      setFiles([]);
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

  /**
   * Takes what the picker gave, in order, while the room lasts: a picture into the pictures, any other file into the
   * files. A file over `MAX_FILE_BYTES` is left out; the hook would refuse it too.
   */
  const addPicked = (picked: PickedFile[]) => {
    let left = room;
    const nextPictures: Picture[] = [];
    const nextFiles: PickedFile[] = [];
    for (const file of picked) {
      if (left <= 0) break;
      if (file.type.startsWith("image/")) {
        pictureSeq += 1;
        nextPictures.push({ key: `pic-${pictureSeq}`, file, url: previewOf(file) });
        left -= 1;
      } else if (file.size <= MAX_FILE_BYTES && KEPT_FILE.test(file.name)) {
        nextFiles.push(file);
        left -= 1;
      }
    }
    if (nextPictures.length > 0) setPictures((old) => [...old, ...nextPictures]);
    if (nextFiles.length > 0) setFiles((old) => [...old, ...nextFiles]);
  };

  const removeFile = (index: number) => {
    setFiles((old) => old.filter((_, at) => at !== index));
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
      {hasAttachments ? (
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
          {files.map((file, index) => (
            <TexChatFileChip
              key={`file-${index}`}
              testID={`tex-picked-file-${index}`}
              name={file.name}
              onRemove={() => removeFile(index)}
              removeLabel={`Remove ${file.name}`}
              removeTestID={`tex-remove-file-${index}`}
            />
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
            onPress={() => chooseFiles(addPicked)}
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
    thumbs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, marginBottom: 8 },
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
    chipText: { flex: 1, minWidth: 0, fontSize: texChatType.small, color: colors.muted },
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
      fontSize: texChatType.composer,
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

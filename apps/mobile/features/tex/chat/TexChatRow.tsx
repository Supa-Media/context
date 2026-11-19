import { useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { pointerType, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import {
  TAPBACKS,
  isPending,
  type AppChatRow,
  type AskChoice,
  type ChatLine,
  type ReactionEmoji,
} from "./appChatGateway";
import { textPieces } from "./appChatText";

/** The longest a picture is drawn, in points. The row keeps its aspect; the overlay shows it whole. */
export const PICTURE_WIDTH = 220;

/** Opens an `https:` link in a new tab. Pure words elsewhere: a link is the only thing made tappable. */
function openLink(href: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

export interface TexChatRowProps {
  line: ChatLine;
  /** This row is the open approval: its two buttons show under the bubble. */
  askOpen: boolean;
  /** The answer the person gave to this row's approval this session, if any. */
  answer: AskChoice | undefined;
  /** An object URL for a picture id, or `null` while it loads. */
  pictureUrl: (id: string) => string | null;
  /** The time under the last row of a group, or `null`. */
  timeLabel: string | null;
  onOpenPicture: (url: string) => void;
  onAnswer: (rowId: string, choice: AskChoice) => void;
  onReact: (rowId: string, emoji: ReactionEmoji) => void;
  onReply: (row: AppChatRow) => void;
  onEdit: (row: AppChatRow) => void;
  onUnsend: (rowId: string) => void;
  onRetry: (localId: string) => void;
  /** Scrolls the log to the row with this id. */
  onJump: (rowId: string) => void;
}

/**
 * One line of the chat with Tex: a bubble, its pictures, its reply quote, its
 * tapbacks, and the actions a person can take on it.
 *
 * Draws what it is given and decides nothing: every change goes back up through
 * a callback, and the hook owns whether it took. Row text is drawn as words,
 * never as HTML; only an `https:` link is tappable.
 */
export function TexChatRow(props: TexChatRowProps) {
  const { line } = props;
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);

  if (isPending(line)) {
    return (
      <View style={[styles.column, styles.mine]} testID={`tex-row-${line.localId}`}>
        {line.replyTo !== undefined ? <ReplyQuote replyTo={line.replyTo} onJump={props.onJump} styles={styles} /> : null}
        {line.previews !== undefined && line.previews.length > 0 ? (
          <View style={[styles.pictures, styles.picturesMine]}>
            {line.previews.map((uri, index) => (
              <Image key={`${uri}-${index}`} source={{ uri }} style={styles.picture} resizeMode="cover" accessibilityLabel="Picture being sent" />
            ))}
          </View>
        ) : null}
        {line.text.length > 0 ? (
          <Bubble mine styles={styles}>
            <Words text={line.text} mine styles={styles} />
          </Bubble>
        ) : null}
        {line.state === "sending" ? (
          <Text variant="meta" style={styles.meta}>
            Sending…
          </Text>
        ) : (
          <View style={styles.row}>
            <Text variant="meta" style={styles.failed}>
              Not sent.
            </Text>
            <Pressable
              onPress={() => props.onRetry(line.localId)}
              accessibilityRole="button"
              accessibilityLabel="Send again"
              style={styles.inlineAction}
              testID={`tex-retry-${line.localId}`}
            >
              <Text variant="meta" style={styles.accentText}>
                Send again
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  const row = line;
  const mine = row.who === "me";
  const answered = props.answer !== undefined;
  const showBar = !row.unsent && (hovered || pinned);
  const canAct = !row.unsent;

  const act = (fn: () => void) => () => {
    setPinned(false);
    setHovered(false);
    fn();
  };

  return (
    <Pressable
      onHoverIn={canAct ? () => setHovered(true) : undefined}
      onHoverOut={canAct ? () => setHovered(false) : undefined}
      onLongPress={canAct ? () => setPinned(true) : undefined}
      delayLongPress={350}
      style={styles.column}
      testID={`tex-row-${row.id}`}
    >
      {row.unsent ? (
        <Text variant="meta" style={[styles.unsent, mine ? styles.alignEnd : styles.alignStart]} testID={`tex-unsent-${row.id}`}>
          {mine ? "You unsent a message" : "Tex unsent a message"}
        </Text>
      ) : (
        <View style={[styles.column, mine ? styles.mine : styles.theirs]}>
          {row.replyTo !== undefined ? <ReplyQuote replyTo={row.replyTo} onJump={props.onJump} styles={styles} /> : null}

          {row.pics !== undefined && row.pics.length > 0 ? (
            <View style={[styles.pictures, mine ? styles.picturesMine : styles.picturesTheirs]}>
              {row.pics.map((id) => (
                <PictureTile key={id} id={id} pictureUrl={props.pictureUrl} onOpen={props.onOpenPicture} styles={styles} />
              ))}
            </View>
          ) : null}

          {row.text.length > 0 ? (
            <Bubble mine={mine} styles={styles} reactions={row.reactions}>
              <Words text={row.text} mine={mine} styles={styles} />
            </Bubble>
          ) : row.reactions !== undefined && row.reactions.length > 0 ? (
            <Reactions reactions={row.reactions} mine={mine} styles={styles} />
          ) : null}

          {row.edited === true ? (
            <Text variant="meta" style={styles.meta} testID={`tex-edited-${row.id}`}>
              Edited
            </Text>
          ) : null}

          {row.ask !== undefined && answered ? (
            <View style={styles.answer} testID={`tex-answer-${row.id}`}>
              <Text variant="meta" style={styles.answerText}>
                {props.answer === "approve" ? "Approved" : "Not sent"}
              </Text>
            </View>
          ) : null}

          {row.ask !== undefined && !answered && props.askOpen ? (
            <View style={styles.decisions}>
              <Button
                label="Approve"
                variant="accent"
                onPress={() => props.onAnswer(row.id, "approve")}
                accessibilityLabel={`Approve: ${row.text}`}
                testID={`tex-approve-${row.id}`}
              />
              <Button
                label="Don't"
                variant="decision"
                onPress={() => props.onAnswer(row.id, "deny")}
                accessibilityLabel={`Don't approve: ${row.text}`}
                testID={`tex-deny-${row.id}`}
              />
            </View>
          ) : null}
        </View>
      )}

      {showBar ? (
        <View style={[styles.bar, mine ? styles.alignEnd : styles.alignStart]} testID={`tex-bar-${row.id}`}>
          {TAPBACKS.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={act(() => props.onReact(row.id, emoji))}
              accessibilityRole="button"
              accessibilityLabel={`React ${emoji}`}
              style={styles.tapback}
              testID={`tex-tapback-${row.id}-${emoji}`}
            >
              <Text variant="body" style={styles.tapbackText}>
                {emoji}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={act(() => props.onReply(row))} accessibilityRole="button" style={styles.barAction} testID={`tex-reply-${row.id}`}>
            <Text variant="meta" style={styles.barText}>
              Reply
            </Text>
          </Pressable>
          {mine && row.editable === true ? (
            <Pressable onPress={act(() => props.onEdit(row))} accessibilityRole="button" style={styles.barAction} testID={`tex-edit-${row.id}`}>
              <Text variant="meta" style={styles.barText}>
                Edit
              </Text>
            </Pressable>
          ) : null}
          {mine && (row.unsendable === true || row.editable === true) ? (
            <Pressable onPress={act(() => props.onUnsend(row.id))} accessibilityRole="button" style={styles.barAction} testID={`tex-unsend-${row.id}`}>
              <Text variant="meta" style={styles.barText}>
                Unsend
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {props.timeLabel !== null ? (
        <Text variant="meta" style={[styles.meta, mine ? styles.alignEnd : styles.alignStart]}>
          {props.timeLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A tappable picture: grey while it loads, full size in the overlay when pressed. */
function PictureTile({
  id,
  pictureUrl,
  onOpen,
  styles,
}: {
  id: string;
  pictureUrl: (id: string) => string | null;
  onOpen: (url: string) => void;
  styles: Styles;
}) {
  const url = pictureUrl(id);
  if (url === null) {
    return <View style={[styles.picture, styles.placeholder]} accessibilityLabel="Picture loading" testID={`tex-pic-${id}`} />;
  }
  return (
    <Pressable onPress={() => onOpen(url)} accessibilityRole="button" accessibilityLabel="Open picture" testID={`tex-pic-${id}`}>
      <Image source={{ uri: url }} style={styles.picture} resizeMode="cover" accessibilityLabel="Picture" />
    </Pressable>
  );
}

function ReplyQuote({
  replyTo,
  onJump,
  styles,
}: {
  replyTo: { id: string; text?: string };
  onJump: (rowId: string) => void;
  styles: Styles;
}) {
  return (
    <Pressable
      onPress={() => onJump(replyTo.id)}
      accessibilityRole="button"
      accessibilityLabel="Go to the message this replies to"
      style={styles.quote}
      testID={`tex-quote-${replyTo.id}`}
    >
      <Text variant="meta" style={styles.meta} numberOfLines={1}>
        {replyTo.text !== undefined && replyTo.text.length > 0 ? replyTo.text : "a message"}
      </Text>
    </Pressable>
  );
}

function Bubble({
  mine,
  styles,
  reactions,
  children,
}: {
  mine: boolean;
  styles: Styles;
  reactions?: AppChatRow["reactions"];
  children: ReactNode;
}) {
  const hasReactions = reactions !== undefined && reactions.length > 0;
  return (
    <View style={[styles.bubbleWrap, hasReactions && styles.bubbleWrapReacted]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>{children}</View>
      {hasReactions ? <Reactions reactions={reactions} mine={mine} styles={styles} /> : null}
    </View>
  );
}

function Reactions({
  reactions,
  mine,
  styles,
}: {
  reactions: NonNullable<AppChatRow["reactions"]>;
  mine: boolean;
  styles: Styles;
}) {
  return (
    <View style={[styles.reactions, mine ? styles.reactionsMine : styles.reactionsTheirs]} testID="tex-reactions">
      {reactions.map((reaction, index) => (
        <View
          key={`${reaction.who}-${index}`}
          style={[styles.badge, reaction.who === "me" ? styles.badgeMine : styles.badgeTheirs]}
          accessibilityLabel={reaction.who === "me" ? "Your reaction" : "Tex's reaction"}
        >
          <Text variant="meta" style={styles.badgeText}>
            {reaction.emoji}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The words, split so an `https:` link is its own tappable piece and everything else plain text. */
function Words({ text, mine, styles }: { text: string; mine: boolean; styles: Styles }) {
  return (
    <Text style={[styles.words, mine ? styles.wordsMine : styles.wordsTheirs]} selectable>
      {textPieces(text).map((piece, index) =>
        piece.kind === "link" ? (
          <Text
            key={index}
            onPress={() => openLink(piece.href)}
            accessibilityRole="link"
            style={[styles.link, mine ? styles.wordsMine : styles.wordsTheirs]}
          >
            {piece.value}
          </Text>
        ) : (
          // Each piece carries the bubble's colour: the design `Text` paints its own default otherwise (white on the accent was lost).
          <Text key={index} style={mine ? styles.wordsMine : styles.wordsTheirs}>
            {piece.value}
          </Text>
        ),
      )}
    </Text>
  );
}

export type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    column: { gap: space.x1, maxWidth: "100%" },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, alignSelf: "flex-end" },
    mine: { alignSelf: "flex-end", alignItems: "flex-end", maxWidth: "85%" },
    theirs: { alignSelf: "flex-start", alignItems: "flex-start", maxWidth: "85%" },
    alignEnd: { alignSelf: "flex-end" },
    alignStart: { alignSelf: "flex-start" },
    meta: { color: colors.muted },
    unsent: { color: colors.muted, fontStyle: "italic" },
    failed: { color: colors.critText },
    accentText: { color: colors.accentText },
    inlineAction: { minHeight: 36, justifyContent: "center" },
    quote: {
      maxWidth: "100%",
      borderLeftWidth: 2,
      borderLeftColor: colors.lineStrong,
      paddingLeft: space.x2,
      paddingVertical: 2,
    },
    pictures: { gap: space.x1, maxWidth: "100%" },
    picturesMine: { alignItems: "flex-end" },
    picturesTheirs: { alignItems: "flex-start" },
    picture: {
      width: PICTURE_WIDTH,
      maxWidth: "100%",
      aspectRatio: 4 / 3,
      borderRadius: radii.card,
      backgroundColor: colors.chrome,
    },
    placeholder: { backgroundColor: colors.chromePressed },
    bubbleWrap: { maxWidth: "100%" },
    bubbleWrapReacted: { paddingTop: space.x2 },
    bubble: {
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      borderWidth: 1,
      borderColor: "transparent",
    },
    bubbleMine: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
      borderBottomRightRadius: 4,
      borderBottomLeftRadius: 14,
    },
    bubbleTheirs: {
      backgroundColor: colors.surface2,
      borderColor: colors.line,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
      borderBottomRightRadius: 14,
      borderBottomLeftRadius: 4,
    },
    words: { fontSize: pointerType.lede, lineHeight: 20, fontWeight: "400" },
    wordsMine: { color: colors.ink },
    wordsTheirs: { color: colors.text },
    link: { textDecorationLine: "underline" },
    reactions: { flexDirection: "row", gap: 2, position: "absolute", top: 0 },
    reactionsMine: { left: -6 },
    reactionsTheirs: { right: -6 },
    badge: {
      minWidth: 22,
      height: 20,
      paddingHorizontal: 4,
      borderRadius: radii.pill,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    badgeMine: { backgroundColor: colors.accentDim, borderColor: colors.lineStrong },
    badgeTheirs: { backgroundColor: colors.surface2, borderColor: colors.lineStrong },
    badgeText: { fontSize: pointerType.meta, lineHeight: 16, color: colors.text },
    answer: { alignSelf: "flex-start" },
    answerText: { color: colors.muted },
    decisions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    bar: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 2,
      padding: 4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
      maxWidth: "100%",
    },
    tapback: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radii.control },
    tapbackText: { fontSize: pointerType.body, lineHeight: 20 },
    barAction: { minHeight: 36, paddingHorizontal: space.x2, justifyContent: "center", borderRadius: radii.control },
    barText: { color: colors.text2 },
  });

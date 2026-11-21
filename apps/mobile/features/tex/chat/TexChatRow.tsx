import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Image, Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space, texChatType } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useReducedMotion } from "../../design/useReducedMotion";
import { isPending, type AnswerChoice, type AppChatRow, type AskChoice, type ChatLine, type ReactionEmoji } from "./appChatGateway";
import { TexChatBar } from "./TexChatBar";
import { chatPlainText } from "./appChatMarkdown";
import { TexChatFileChip, formatFileSize } from "./TexChatFileChip";
import { TexChatWords } from "./TexChatWords";
import { TexAskCard, askLead } from "./TexAskCard";

/** The longest a picture is drawn, in points. The row keeps its aspect; the overlay shows it whole. */
export const PICTURE_WIDTH = 220;
/** How long a jumped-to row keeps its highlight, in ms. */
const FLASH_MS = 1400;
/** The most of a reply's words the quote shows before it is cut. */
const QUOTE_CHARS = 70;

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
  /** Set by the parent after a jump to this row; the bubble lights for a moment. */
  flash?: boolean;
  onOpenPicture: (url: string) => void;
  /** Saves a file the row carries, by its id and name. */
  onDownloadFile?: (id: string, name: string) => void;
  onAnswer: (rowId: string, choice: AskChoice) => void;
  /** A card's answer: send, with the words when the person changed them, or hold. */
  onDecide: (rowId: string, choice: AnswerChoice, body?: string) => void;
  onReact: (rowId: string, emoji: ReactionEmoji) => void;
  onReply: (row: AppChatRow) => void;
  onEdit: (row: AppChatRow) => void;
  onCopy?: (row: AppChatRow) => void;
  onUnsend: (rowId: string) => void;
  onRetry: (localId: string) => void;
  /** Scrolls the log to the row with this id. */
  onJump: (rowId: string) => void;
  /** Opens a note a link in the words points at, or `null` for none. */
  onOpenNote?: ((href: string, path: string) => void) | null;
  /** Drawn under the bubble, above its time: the chat engine's delivery, failed and queued lines (section A). */
  below?: ReactNode;
}

/** How long the bar stays after the pointer leaves the row, to reach it across the gap above the bubble. */
const HOVER_GRACE_MS = 200;

/**
 * One line of the chat with Tex: a bubble, its pictures, its reply quote, its
 * tapbacks, and the actions a person can take on it.
 *
 * Draws what it is given and decides nothing: every change goes back up through
 * a callback, and the hook owns whether it took. The hover bar is absolutely
 * placed, so showing it never moves a row. It shows while the row is hovered,
 * focused, or pinned by a long press or a touch tap.
 */
export function TexChatRow(props: TexChatRowProps) {
  const { line } = props;
  const styles = useThemedStyles(makeStyles);
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (leaving.current !== null) clearTimeout(leaving.current);
  }, []);
  // The bar floats above the bubble, over the row before it, so the pointer
  // leaves the row on its way up to it: a short grace keeps it up, and the bar
  // itself counts as the row while the pointer is on it.
  const onBar = useRef(false);
  const hoverIn = () => {
    if (leaving.current !== null) clearTimeout(leaving.current);
    leaving.current = null;
    setHovered(true);
  };
  const hoverOut = () => {
    if (leaving.current !== null) clearTimeout(leaving.current);
    leaving.current = setTimeout(() => {
      leaving.current = null;
      if (!onBar.current) setHovered(false);
    }, HOVER_GRACE_MS);
  };
  const barIn = () => {
    onBar.current = true;
    hoverIn();
  };
  const barOut = () => {
    onBar.current = false;
    hoverOut();
  };
  const [pinned, setPinned] = useState(false);
  const [focused, setFocused] = useState(false);
  const lit = useFlash(props.flash === true);

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
        {line.fileNames !== undefined && line.fileNames.length > 0 ? (
          <View style={[styles.pictures, styles.picturesMine]}>
            {line.fileNames.map((name, index) => (
              <TexChatFileChip key={`${name}-${index}`} testID={`tex-pending-file-${index}`} name={name} />
            ))}
          </View>
        ) : null}
        {line.text.length > 0 ? (
          <Bubble mine styles={styles} reduced={reduced}>
            <TexChatWords text={line.text} mine onOpenNote={props.onOpenNote} />
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
  // A card replaces the ask's old Approve and Decline block, and the email copy in its text: Tex's lead stays a bubble
  // over the card (the mock).
  const card = row.ask?.card;
  const words = card !== undefined ? askLead(row.text) : row.text;
  const answered = props.answer !== undefined;
  const canAct = !row.unsent;
  // A card carries its own reply arrow and its own buttons, so it gets no hover bar (the mock).
  const showBar = canAct && card === undefined && (hovered || pinned || focused);
  const ownReaction = row.reactions?.find((reaction) => reaction.who === "me")?.emoji;

  // Every action settles the bar first: pressing one unpins it.
  const act = (fn: () => void) => () => {
    setPinned(false);
    setHovered(false);
    setFocused(false);
    fn();
  };

  return (
    <Pressable
      onHoverIn={canAct ? hoverIn : undefined}
      onHoverOut={canAct ? hoverOut : undefined}
      onLongPress={canAct ? () => setPinned(true) : undefined}
      onPress={canAct && tapPins() ? () => setPinned((on) => !on) : undefined}
      onFocus={canAct ? () => setFocused(true) : undefined}
      onBlur={canAct ? () => setFocused(false) : undefined}
      delayLongPress={350}
      style={styles.column}
      testID={`tex-row-${row.id}`}
    >
      {row.unsent ? (
        <Text variant="meta" style={[styles.unsent, mine ? styles.alignEnd : styles.alignStart]} testID={`tex-unsent-${row.id}`}>
          {mine ? "You unsent a message" : "Tex unsent a message"}
        </Text>
      ) : (
        <View style={[styles.column, card !== undefined ? styles.full : mine ? styles.mine : styles.theirs]}>
          {showBar ? (
            <TexChatBar
              rowId={row.id}
              text={chatPlainText(row.text)}
              mine={mine}
              ownReaction={ownReaction}
              canEdit={mine && row.editable === true}
              canUnsend={mine && (row.unsendable === true || row.editable === true)}
              reduced={reduced}
              onReact={(emoji) => act(() => props.onReact(row.id, emoji))()}
              onReply={act(() => props.onReply(row))}
              onEdit={act(() => props.onEdit(row))}
              onUnsend={act(() => props.onUnsend(row.id))}
              onCopied={act(() => props.onCopy?.(row))}
              onPointerEnter={barIn}
              onPointerLeave={barOut}
            />
          ) : null}

          {row.replyTo !== undefined ? <ReplyQuote replyTo={row.replyTo} onJump={props.onJump} styles={styles} /> : null}

          {row.pics !== undefined && row.pics.length > 0 ? (
            <View style={[styles.pictures, mine ? styles.picturesMine : styles.picturesTheirs]}>
              {row.pics.map((id) => (
                <PictureTile key={id} id={id} pictureUrl={props.pictureUrl} onOpen={props.onOpenPicture} styles={styles} />
              ))}
            </View>
          ) : null}

          {row.files !== undefined && row.files.length > 0 ? (
            <View style={[styles.pictures, mine ? styles.picturesMine : styles.picturesTheirs]}>
              {row.files.map((file) => (
                <TexChatFileChip
                  key={file.id}
                  testID={`tex-file-${file.id}`}
                  name={file.name}
                  detail={formatFileSize(file.size)}
                  onPress={() => props.onDownloadFile?.(file.id, file.name)}
                  pressLabel={`Download ${file.name}`}
                />
              ))}
            </View>
          ) : null}

          {card !== undefined && words.length > 0 ? (
            <View style={styles.theirs} testID={`tex-ask-lead-${row.id}`}>
              <Bubble mine={mine} styles={styles} reactions={row.reactions} reduced={reduced} lit={lit}>
                <TexChatWords text={words} mine={mine} onOpenNote={props.onOpenNote} />
              </Bubble>
            </View>
          ) : null}

          {card !== undefined ? (
            <TexAskCard rowId={row.id} card={card} onDecide={props.onDecide} onReply={() => props.onReply(row)} />
          ) : row.text.length > 0 ? (
            <Bubble mine={mine} styles={styles} reactions={row.reactions} reduced={reduced} lit={lit}>
              <TexChatWords text={row.text} mine={mine} onOpenNote={props.onOpenNote} />
            </Bubble>
          ) : row.reactions !== undefined && row.reactions.length > 0 ? (
            <Reactions reactions={row.reactions} mine={mine} styles={styles} reduced={reduced} />
          ) : null}

          {row.edited === true ? (
            <Text variant="meta" style={styles.meta} testID={`tex-edited-${row.id}`}>
              Edited
            </Text>
          ) : null}

          {card === undefined && row.ask !== undefined && answered ? (
            <View style={styles.askCard} testID={`tex-answer-${row.id}`}>
              <Text variant="meta" style={styles.answerText}>
                {props.answer === "approve" ? "Approved" : "Declined"}
              </Text>
            </View>
          ) : null}

          {card === undefined && row.ask !== undefined && !answered && props.askOpen ? (
            <View style={styles.askCard}>
              <Text variant="meta" style={styles.askHeading}>
                Waiting for your OK
              </Text>
              <View style={styles.decisions}>
                <Button
                  label="Approve"
                  variant="accent"
                  onPress={() => props.onAnswer(row.id, "approve")}
                  accessibilityLabel={`Approve: ${row.text}`}
                  testID={`tex-approve-${row.id}`}
                />
                <Button
                  label="Decline"
                  variant="decision"
                  onPress={() => props.onAnswer(row.id, "deny")}
                  accessibilityLabel={`Decline: ${row.text}`}
                  testID={`tex-deny-${row.id}`}
                />
              </View>
            </View>
          ) : null}
        </View>
      )}

      {props.below ?? null}

      {props.timeLabel !== null ? (
        <Text variant="meta" style={[styles.meta, mine ? styles.alignEnd : styles.alignStart]}>
          {props.timeLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Whether a tap on the row should pin its bar: only where there is no hover to
 * show it. A mouse click on a pointer device does not pin; a tap on a touch
 * screen, or on native, does.
 */
function tapPins(): boolean {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return !window.matchMedia("(hover: hover)").matches;
    }
  } catch {
    // No media query support: treat as a touch surface.
  }
  return true;
}

/** Lights a bubble for `FLASH_MS` each time `flash` turns on. */
function useFlash(flash: boolean): boolean {
  const [lit, setLit] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!flash) return;
    setLit(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLit(false), FLASH_MS);
  }, [flash]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return lit;
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
  const words =
    replyTo.text !== undefined && replyTo.text.length > 0 ? replyTo.text.slice(0, QUOTE_CHARS) : "a message";
  return (
    <Pressable
      onPress={() => onJump(replyTo.id)}
      accessibilityRole="button"
      accessibilityLabel="Go to the message this replies to"
      style={styles.quote}
    >
      <Text variant="meta" style={styles.meta}>
        ↪
      </Text>
      <Text variant="meta" style={[styles.meta, styles.quoteWords]} numberOfLines={1} testID={`tex-quote-${replyTo.id}`}>
        {words}
      </Text>
    </Pressable>
  );
}

function Bubble({
  mine,
  styles,
  reactions,
  reduced,
  lit = false,
  children,
}: {
  mine: boolean;
  styles: Styles;
  reactions?: AppChatRow["reactions"];
  reduced: boolean;
  /** The bubble is the target of a jump and is lit. */
  lit?: boolean;
  children: ReactNode;
}) {
  const hasReactions = reactions !== undefined && reactions.length > 0;
  return (
    <View style={styles.bubbleWrap}>
      {lit ? <View style={styles.flashRing} pointerEvents="none" testID="tex-flash" /> : null}
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>{children}</View>
      {hasReactions ? <Reactions reactions={reactions} mine={mine} styles={styles} reduced={reduced} /> : null}
    </View>
  );
}

function Reactions({
  reactions,
  mine,
  styles,
  reduced,
}: {
  reactions: NonNullable<AppChatRow["reactions"]>;
  mine: boolean;
  styles: Styles;
  reduced: boolean;
}) {
  return (
    <View style={[styles.reactions, mine ? styles.reactionsMine : styles.reactionsTheirs]} testID="tex-reactions">
      {reactions.map((reaction, index) => (
        <ReactionBadge key={`${reaction.who}-${index}`} reaction={reaction} styles={styles} reduced={reduced} />
      ))}
    </View>
  );
}

/** One tapback badge. It springs in from a fifth of its size, and not at all under reduced motion. */
function ReactionBadge({
  reaction,
  styles,
  reduced,
}: {
  reaction: NonNullable<AppChatRow["reactions"]>[number];
  styles: Styles;
  reduced: boolean;
}) {
  const pop = useRef(new Animated.Value(reduced ? 1 : 0.2)).current;

  useEffect(() => {
    if (reduced) return;
    Animated.spring(pop, { toValue: 1, friction: 5, tension: 180, useNativeDriver: true }).start();
  }, [pop, reduced]);

  return (
    <Animated.View
      style={[styles.badge, reaction.who === "tex" ? styles.badgeTex : styles.badgeMe, { transform: [{ scale: pop }] }]}
      accessibilityLabel={reaction.who === "me" ? "Your reaction" : "Tex's reaction"}
    >
      <Text style={styles.badgeText}>{reaction.emoji}</Text>
    </Animated.View>
  );
}

export type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    column: { gap: space.x1, maxWidth: "100%", position: "relative" },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, alignSelf: "flex-end" },
    mine: { alignSelf: "flex-end", alignItems: "flex-end", maxWidth: "86%" },
    theirs: { alignSelf: "flex-start", alignItems: "flex-start", maxWidth: "86%" },
    alignEnd: { alignSelf: "flex-end" },
    alignStart: { alignSelf: "flex-start" },
    full: { alignSelf: "stretch", maxWidth: "100%" },
    meta: { color: colors.muted },
    unsent: { color: colors.muted, fontStyle: "italic" },
    failed: { color: colors.critText },
    accentText: { color: colors.accentText },
    inlineAction: { minHeight: 36, justifyContent: "center" },
    quote: {
      maxWidth: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      borderLeftWidth: 2,
      borderLeftColor: colors.line,
      paddingVertical: 2,
      paddingHorizontal: space.x2,
    },
    quoteWords: { flexShrink: 1 },
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
    bubbleWrap: { maxWidth: "100%", position: "relative" },
    flashRing: {
      position: "absolute",
      top: -4,
      right: -4,
      bottom: -4,
      left: -4,
      borderRadius: 20,
      backgroundColor: colors.accentDim,
    },
    bubble: {
      zIndex: 1,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      borderWidth: 1,
      borderColor: "transparent",
    },
    bubbleMine: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderBottomRightRadius: 5,
      borderBottomLeftRadius: 16,
    },
    bubbleTheirs: {
      backgroundColor: colors.ground,
      borderColor: colors.line,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderBottomRightRadius: 16,
      borderBottomLeftRadius: 5,
    },
    reactions: { flexDirection: "row", gap: 2, position: "absolute", top: -10, zIndex: 2 },
    reactionsMine: { left: -12 },
    reactionsTheirs: { right: -12 },
    badge: {
      minWidth: 22,
      height: 20,
      paddingHorizontal: 5,
      borderRadius: radii.pill,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.ground,
      boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
    },
    badgeMe: { borderColor: colors.line },
    badgeTex: { borderColor: colors.accent },
    badgeText: { fontSize: texChatType.small, lineHeight: 20, color: colors.text },
    askCard: {
      alignSelf: "flex-start",
      gap: space.x2,
      padding: space.x3,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
    },
    askHeading: { color: colors.muted },
    answerText: { color: colors.text2 },
    decisions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
  });

/**
 * The Channel-day view: one day, grouped by thread, each message with its
 * sender, time, body and attachments — and, when a caller names an anchor
 * (`noteHref`'s routing contract), scrolled into view.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { FileBrowser } from "../files/browser";
import { channelDayNotePath } from "@context/communications";
import { shapeChannelDay, type DayPartSource } from "./day";
import { splitParagraphs, tokenizeInline } from "./markdownInline";
import type { CommsChannel, DayMessageView } from "./types";

/** How many split parts a day can have before this view stops fetching more. */
const MAX_PARTS_FETCHED = 50;

export function ChannelDayView({
  channel,
  account,
  date,
  knownParts,
  files,
  anchor,
}: {
  channel: CommsChannel;
  account: string;
  date: string;
  /**
   * How many parts this day has, if the caller already knows — from
   * `ChannelDayRow.parts`, say. `undefined` means "find out", and this view
   * fetches part 1 first and follows `parts` in that note's own frontmatter,
   * the same way a reader who only has one link into a split day would.
   */
  knownParts?: number;
  files: FileBrowser;
  /** The message to scroll to, from `?anchor=` — see `nav.ts`'s `noteHref`. */
  anchor?: string | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const scroller = useRef<ScrollView>(null);
  /** Each mounted message's own node, keyed by anchor — see the scroll effect below. */
  const messageNodes = useRef<Map<string, View>>(new Map());
  const [scrolledTo, setScrolledTo] = useState<string | null>(null);
  const [parts, setParts] = useState<number | null>(knownParts ?? null);

  const partPaths = useMemo(() => {
    const count = Math.min(parts ?? 1, MAX_PARTS_FETCHED);
    return Array.from({ length: count }, (_, index) =>
      channelDayNotePath({ channel, account, date, part: index + 1 }),
    );
  }, [channel, account, date, parts]);

  const [partTexts, setPartTexts] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    for (const path of partPaths) {
      if (path in partTexts) continue;
      void files.readRaw(path).then((note) => {
        if (cancelled) return;
        setPartTexts((current) => ({ ...current, [path]: note?.text ?? null }));
        if (path === partPaths[0] && note !== null && parts === null) {
          const declared = Number(note.text.match(/^parts: "?(\d+)"?$/m)?.[1]);
          if (Number.isFinite(declared) && declared > 0) setParts(declared);
          else setParts(1);
        }
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, partPaths.join("|")]);

  const partSources = useMemo<DayPartSource[]>(
    () =>
      partPaths.map((path, index) => ({
        part: index + 1,
        text: path in partTexts ? partTexts[path]! : null,
      })),
    [partPaths, partTexts],
  );

  const loaded = partPaths.every((path) => path in partTexts);
  const view = useMemo(
    () => shapeChannelDay(channel, account, date, partSources),
    [channel, account, date, partSources],
  );

  /**
   * Scroll to the requested anchor once its message has mounted.
   *
   * **Measured against the scroll container, not accumulated from `onLayout`
   * offsets.** A message sits two `View`s below the `ScrollView`
   * (`page` → `thread` → the message), and `onLayout`'s `layout.y` is
   * relative to a node's *immediate parent* — so the message's own `onLayout`
   * would report its position inside its thread, not its position in the
   * whole scrollable content, and every thread after the first would scroll
   * short by the height of every thread before it. `getBoundingClientRect`
   * answers "where is this, on screen" regardless of how deep it is nested,
   * which is the property this actually needs.
   *
   * react-native-web forwards a `View`/`ScrollView` ref to its real DOM node
   * — measured directly against this library's own source, which attaches
   * `scrollTo` to that same node rather than to a wrapper — so both refs
   * below are genuine `HTMLElement`s on web. Native does not have a DOM to
   * measure against; feature-detecting `getBoundingClientRect` rather than
   * branching on `Platform.OS` means this degrades to "the day opens
   * unscrolled" there — reported by simply doing nothing, never a crash —
   * until a native measurement path is built. See
   * `docs/decisions/app-and-console.md`.
   *
   * `scrolledTo` guards against re-scrolling on every later reflow (a
   * paragraph above the target changing height, say) — the anchor is
   * honoured once per visit, the way following a link should feel.
   */
  useEffect(() => {
    if (!anchor || scrolledTo === anchor) return;
    const target = messageNodes.current.get(anchor);
    const host = scroller.current;
    if (!target || !host) return;

    const targetEl = target as unknown as { getBoundingClientRect?: () => { top: number } };
    const hostEl = host as unknown as {
      getBoundingClientRect?: () => { top: number };
      scrollTop?: number;
      scrollTo?: (options: { x?: number; y?: number; animated?: boolean }) => void;
    };
    if (
      typeof targetEl.getBoundingClientRect !== "function" ||
      typeof hostEl.getBoundingClientRect !== "function" ||
      typeof hostEl.scrollTo !== "function"
    ) {
      return;
    }

    const targetTop = targetEl.getBoundingClientRect().top;
    const hostTop = hostEl.getBoundingClientRect().top;
    const currentScroll = hostEl.scrollTop ?? 0;
    const nextScroll = Math.max(0, currentScroll + (targetTop - hostTop) - space.x4);
    hostEl.scrollTo({ y: nextScroll, animated: true });
    setScrolledTo(anchor);
  }, [anchor, scrolledTo, view]);

  return (
    <ScrollView ref={scroller} style={styles.scroll} testID="channel-day-scroll">
      <View style={styles.page}>
        <Text variant="noteTitle" role="heading" aria-level={2}>
          {date}
          {account ? ` · ${account}` : ""}
        </Text>

        {!loaded && view.threads.length === 0 ? (
          <Text variant="meta" style={styles.aside}>
            Loading…
          </Text>
        ) : null}

        {loaded && view.partial ? (
          <Text variant="hint" style={styles.notice}>
            Part of this day could not be read. What loaded is shown below.
          </Text>
        ) : null}

        {view.threads.map((thread) => (
          <View key={thread.thread} style={styles.thread}>
            <Text variant="rowSub" style={styles.threadHeading}>
              {thread.thread || "(no thread)"}
            </Text>
            {thread.messages.map((message) => (
              <MessageCard
                key={message.anchor}
                message={message}
                registerNode={(node) => {
                  if (node) messageNodes.current.set(message.anchor, node);
                  else messageNodes.current.delete(message.anchor);
                }}
              />
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function MessageCard({
  message,
  registerNode,
}: {
  message: DayMessageView;
  /** Hands back this message's own `View` node once mounted, `null` on unmount. */
  registerNode: (node: View | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const paragraphs = splitParagraphs(message.body);
  return (
    <View
      ref={registerNode}
      style={styles.message}
      testID={`message-${message.anchor}`}
    >
      <View style={styles.messageHead}>
        <Text variant="rowTitle" numberOfLines={1} style={styles.sender}>
          {message.sender}
        </Text>
        <Text variant="treeMeta">{message.time}</Text>
      </View>
      <Text variant="body" style={styles.subject} numberOfLines={2}>
        {message.subject}
      </Text>
      <View style={styles.body}>
        {paragraphs.length === 0 ? (
          <Text variant="meta">_(no readable text)_</Text>
        ) : (
          paragraphs.map((paragraph, index) => (
            <Text key={index} variant="body" style={styles.paragraph}>
              {tokenizeInline(paragraph).map((token, tokenIndex) => (
                <Text
                  key={tokenIndex}
                  style={[
                    token.bold ? styles.bold : undefined,
                    token.italic ? styles.italic : undefined,
                    token.code ? styles.code : undefined,
                  ]}
                >
                  {token.text}
                </Text>
              ))}
            </Text>
          ))
        )}
      </View>
      {message.attachments.length > 0 ? (
        <View style={styles.attachments}>
          {message.attachments.map((attachment, index) => (
            <Text key={index} variant="treeMeta" style={styles.attachment}>
              📎 {attachment.filename} — {attachment.contentType}, {attachment.size}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  page: { padding: space.x4, gap: space.x3 },
  aside: { color: colors.muted },
  notice: { color: colors.warnText },
  thread: { gap: space.x2, marginTop: space.x3 },
  threadHeading: { color: colors.muted },
  message: {
    borderWidth: 1,
    borderColor: colors.hintBorder,
    borderRadius: radii.md,
    padding: space.x3,
    gap: space.x1,
  },
  messageHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sender: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  subject: { color: colors.muted },
  body: { marginTop: space.x1, gap: space.x2 },
  paragraph: {},
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  code: { fontFamily: "monospace" },
  attachments: { marginTop: space.x2, gap: 4 },
  attachment: { color: colors.muted },
});

import { useEffect, useMemo } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { fonts, space, pointerType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { whenText } from "../feed";
import type { MapPageState } from "../hooks/useMapPage";
import { useNotePeek, type NotePeekText } from "../hooks/useNotePeek";
import { lastWritten, peekCrumbs, peekPlacement, peekPresence, presenceChips, type PeekBlock, type PeekNote, type PresenceChip } from "../peek/peekModel";

/** The note a dot tap opened, and where on the canvas the tap was (none when the map came back with it open). */
export type OpenPeek = PeekNote & { at: { x: number; y: number } | null };

const CARD = { width: 380, height: 460 };

/**
 * The card a tapped dot opens, instead of leaving the map: the note's words,
 * who is writing it and who is reading it, and what is being typed as it is
 * typed (the blocks that changed since the last read are marked, with a caret
 * after the latest). Expand opens the whole note at its own place in history,
 * so Back comes to the map again with this card still open. On a pointer
 * layout it sits beside the dot; on a phone it is a sheet over the map's own.
 *
 * Reading is shown for the whole note: the map knows which notes were read,
 * not which parts.
 */
export function NotePeek({
  page,
  peek,
  compact,
  box,
  onClose,
  onExpand,
}: {
  page: MapPageState;
  peek: OpenPeek;
  compact: boolean;
  box: { width: number; height: number };
  onClose: () => void;
  onExpand: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const presence = useMemo(() => peekPresence(page.working, peek), [page.working, peek]);
  const writing = presence.writers.length > 0 && !page.replaying;
  const text = useNotePeek(peek, writing);
  const title = page.book.title(peek.workspaceId, peek.path);
  const crumbs = peekCrumbs(peek.path);
  const chips = presenceChips(presence);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const card = { width: Math.min(CARD.width, box.width - 24), height: Math.min(CARD.height, box.height - 24) };
  const place = compact ? null : peekPlacement(peek.at, box, card);
  const written = writing ? null : lastWritten(page.events, peek);
  const updated = writing ? "Being written now" : written !== null ? `Edited ${whenText({ now: false, at: written }, page.now)}` : null;

  return (
    <View
      style={compact ? styles.sheet : [styles.card, { left: place!.left, top: place!.top, width: card.width, maxHeight: card.height }]}
      accessibilityRole="none"
      aria-label={`Preview of ${title}`}
      testID="map-peek"
    >
      {compact ? <View style={styles.grab} /> : null}
      <View style={styles.head}>
        <Text style={styles.crumbs} numberOfLines={1}>
          {crumbs === "" ? page.book.workspace(peek.workspaceId) : isolateForDisplay(crumbs)}
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close preview" style={[styles.close, compact && styles.closePhone]} testID="map-peek-close">
          <Icon name="close" size={14} color={colors.text2} />
        </Pressable>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {chips.length > 0 ? (
        <View style={styles.chips}>
          {chips.map((chip) => (
            <Chip key={chip.text} chip={chip} />
          ))}
        </View>
      ) : null}
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner} testID="map-peek-body">
        <PeekText text={text} writing={writing} writer={presence.writers[0] ?? null} />
      </ScrollView>
      <View style={[styles.foot, compact && styles.footPhone]}>
        {!compact ? (
          <Text style={styles.meta} numberOfLines={1}>
            {updated ?? ""}
          </Text>
        ) : null}
        <Pressable
          onPress={onExpand}
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}`}
          style={[styles.expand, compact && styles.expandPhone]}
          testID="map-peek-expand"
        >
          <Text style={styles.expandText}>{compact ? "Open note" : "Expand"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Chip({ chip }: { chip: PresenceChip }) {
  const styles = useThemedStyles(makeStyles);
  const writing = chip.kind === "writing";
  return (
    <View style={[styles.chip, writing ? styles.chipWriting : styles.chipReading]} testID={`map-peek-${chip.kind}`}>
      {writing ? <View style={styles.liveDot} /> : null}
      <Text style={[styles.chipText, writing ? styles.chipTextWriting : styles.chipTextReading]} numberOfLines={1}>
        {chip.text}
      </Text>
    </View>
  );
}

function PeekText({ text, writing, writer }: { text: NotePeekText; writing: boolean; writer: string | null }) {
  const styles = useThemedStyles(makeStyles);
  if (text.state === "loading") return <Text style={styles.quiet}>Opening…</Text>;
  if (text.state === "failed") return <Text style={styles.quiet}>This note couldn't be read just now.</Text>;
  if (text.state === "sealed") return <Text style={styles.quiet}>This note is encrypted. Expand to read it.</Text>;
  if (text.blocks.length === 0) return <Text style={styles.quiet}>{writing ? "Nothing written yet." : "This note is empty."}</Text>;
  const changed = new Set(text.changed);
  const caretAt = writing ? (text.changed.length > 0 ? text.changed[text.changed.length - 1]! : text.blocks.length - 1) : -1;
  return (
    <>
      {text.blocks.map((block, i) => (
        <Block key={i} block={block} changed={changed.has(i)} caret={i === caretAt} writer={writer} />
      ))}
    </>
  );
}

function Block({ block, changed, caret, writer }: { block: PeekBlock; changed: boolean; caret: boolean; writer: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const style =
    block.kind === "heading" ? (block.level <= 2 ? styles.h2 : styles.h3) : block.kind === "code" ? styles.code : styles.para;
  return (
    <View style={[styles.block, changed && styles.blockChanged]} testID={changed ? "map-peek-changed" : undefined}>
      <Text style={style}>
        {block.kind === "item" ? "•  " : ""}
        {isolateForDisplay(block.text)}
        {caret ? <Text style={styles.caret}>▍</Text> : null}
      </Text>
      {caret && writer !== null ? (
        <Text style={styles.caretName} numberOfLines={1} testID="map-peek-caret">
          {writer}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      position: "absolute",
      borderRadius: 16,
      backgroundColor: colors.pageSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      shadowColor: "#000",
      shadowOpacity: 0.28,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: 12 },
      overflow: "hidden",
    },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: "58%",
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      backgroundColor: colors.pageSurface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: -4 },
      overflow: "hidden",
    },
    grab: { alignSelf: "center", width: 38, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: colors.lineStrong },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingLeft: 18, paddingRight: 8, paddingTop: 10 },
    crumbs: { flex: 1, fontFamily: fonts.body, fontSize: pointerType.meta, color: colors.chromeMuted },
    close: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    closePhone: { width: 44, height: 44, borderRadius: 22 },
    title: { marginHorizontal: 18, fontFamily: fonts.body, fontSize: pointerType.h3, fontWeight: "600", color: colors.text },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 18, paddingTop: 10 },
    chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, maxWidth: "100%" },
    chipWriting: { backgroundColor: colors.accentDim },
    chipReading: { backgroundColor: colors.warnWash },
    liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
    chipText: { fontFamily: fonts.body, fontSize: pointerType.meta, fontWeight: "600", flexShrink: 1 },
    chipTextWriting: { color: colors.accentText },
    chipTextReading: { color: colors.warnText },
    body: { flexGrow: 1, flexShrink: 1, marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    bodyInner: { paddingHorizontal: 18, paddingVertical: 12, gap: 8 },
    block: { marginHorizontal: -8, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
    blockChanged: { backgroundColor: colors.accentDim },
    h2: { fontFamily: fonts.body, fontSize: pointerType.body, fontWeight: "600", color: colors.text },
    h3: { fontFamily: fonts.body, fontSize: pointerType.lede, fontWeight: "600", color: colors.text },
    para: { fontFamily: fonts.body, fontSize: pointerType.lede, lineHeight: 22, color: colors.text2 },
    code: { fontFamily: fonts.mono, fontSize: pointerType.ui, lineHeight: 19, color: colors.text2 },
    caret: { color: colors.accent },
    caretName: {
      alignSelf: "flex-start",
      marginTop: 2,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 4,
      overflow: "hidden",
      fontFamily: fonts.body,
      fontSize: pointerType.label,
      fontWeight: "600",
      color: colors.pageSurface,
      backgroundColor: colors.accent,
    },
    quiet: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.chromeMuted },
    foot: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingLeft: 18,
      paddingRight: 14,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    footPhone: { paddingHorizontal: 18, paddingBottom: 24 },
    meta: { flex: 1, fontFamily: fonts.body, fontSize: pointerType.meta, color: colors.chromeMuted },
    expand: { height: 36, paddingHorizontal: 16, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.text },
    expandPhone: { flex: 1, height: 48, borderRadius: 12 },
    expandText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.pageSurface },
  });

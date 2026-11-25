/**
 * The Data page's sources (board 01): on a pointer layout, cards in two
 * columns, each with its mark, name, how it stands and one row per dataset
 * with its row count; on a phone, one row per source. A card opens the
 * source's folder, and a dataset row its sheet.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, touchType } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { ChevronGlyph, SheetGlyph, SourceMark, WarnGlyph } from "./Marks";
import { StatusDot } from "./Parts";
import { cardColumns, type DataSource } from "./sources";
import type { Sheet } from "./workOut";
import { datasetsWords, kindLine, rowsWords, type Status } from "./words";

export interface SourceCard {
  readonly source: DataSource;
  readonly status: Status;
  readonly datasets: readonly { name: string; path: string; computed: boolean; sheet: Sheet | null }[];
}

export function SourceCards({ cards, compact, onOpen }: { cards: readonly SourceCard[]; compact: boolean; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  if (compact) {
    return (
      <View>
        {cards.map((card) => (
          <PhoneSource key={card.source.folder} card={card} onOpen={onOpen} />
        ))}
      </View>
    );
  }
  const [left, right] = cardColumns(cards);
  return (
    <View style={styles.columns}>
      {[left, right].map((column, at) => (
        <View key={at} style={styles.column}>
          {column.map((card) => (
            <Card key={card.source.folder} card={card} onOpen={onOpen} />
          ))}
        </View>
      ))}
    </View>
  );
}

function StatusLine({ status, short = false, compact = false, prefix }: { status: Status; short?: boolean; compact?: boolean; prefix?: string }) {
  const styles = useThemedStyles(makeStyles);
  const text = [prefix, short ? status.short : status.text].filter((part) => part !== undefined && part !== "").join(" · ");
  return (
    <View style={styles.statusLine}>
      {status.tone === "bad" ? <WarnGlyph size={11} /> : compact ? null : <StatusDot tone={status.tone} />}
      <Text style={[styles.status, compact && styles.statusCompact, status.tone === "bad" && styles.bad]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function Card({ card, onOpen }: { card: SourceCard; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const line = kindLine(card.source.kind);
  return (
    <View style={[styles.card, hovered && styles.cardHover]} testID="source-card">
      <Pressable
        role="link"
        accessibilityLabel={`Open ${card.source.name}`}
        onPress={() => onOpen(card.source.folder)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={styles.cardHead}
      >
        <SourceMark kind={card.source.kind} size={28} />
        <View style={styles.cardTitle}>
          <Text style={styles.name} numberOfLines={1}>
            {card.source.name}
            {line === null ? null : <Text style={styles.nameSub}>{` · ${line}`}</Text>}
          </Text>
          <StatusLine status={card.status} />
        </View>
        <ChevronGlyph size={14} color={colors.chromeMuted} />
      </Pressable>
      {card.datasets.map((dataset) => (
        <Pressable
          key={dataset.path}
          role="link"
          accessibilityLabel={`Open ${dataset.name}`}
          onPress={() => onOpen(dataset.computed ? card.source.folder : dataset.path)}
          style={(state) => [styles.dataset, (state as { hovered?: boolean }).hovered === true && styles.datasetHover]}
        >
          <SheetGlyph size={13} color={colors.chromeMuted} />
          <Text style={styles.datasetName} numberOfLines={1}>
            {dataset.name}
          </Text>
          <Text style={styles.count}>{dataset.sheet === null ? "—" : rowsWords(dataset.sheet.rows.length)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function PhoneSource({ card, onOpen }: { card: SourceCard; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable role="link" accessibilityLabel={`Open ${card.source.name}`} onPress={() => onOpen(card.source.folder)} style={styles.phoneRow} testID="source-card">
      <SourceMark kind={card.source.kind} size={28} />
      <View style={styles.cardTitle}>
        <Text style={styles.phoneName} numberOfLines={1}>
          {card.source.name}
        </Text>
        <StatusLine status={card.status} short compact prefix={datasetsWords(card.datasets.length)} />
      </View>
      <ChevronGlyph size={14} color={colors.chromeMuted} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    columns: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
    column: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.cardSurface,
      marginBottom: 12,
      overflow: "hidden",
    },
    cardHover: { borderColor: colors.lineStrong },
    cardHead: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12 },
    cardTitle: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    name: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text },
    nameSub: { fontWeight: "400", color: colors.muted },
    statusLine: { flexDirection: "row", alignItems: "center", gap: 5 },
    status: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 1 },
    statusCompact: { fontSize: pointerType.meta, lineHeight: 17 },
    bad: { color: colors.critText },
    dataset: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      height: 32,
      paddingHorizontal: 12,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    datasetHover: { backgroundColor: colors.chipFill },
    datasetName: { flexGrow: 1, flexShrink: 1, fontSize: pointerType.meta, lineHeight: 16, color: colors.text2 },
    count: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    phoneRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 6 },
    phoneName: { fontSize: touchType.ui, lineHeight: 20, fontWeight: "600", color: colors.text },
  });

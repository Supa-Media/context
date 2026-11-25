/**
 * The head of a data page (boards 01, 07, 09, 10 and 11): its tile, its name,
 * a status line under the name where it has one, its buttons on the right
 * (on a phone, a row of their own under it), and the lede.
 */

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, touchType } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { WarnGlyph } from "./Marks";
import { StatusDot } from "./Parts";
import type { Status } from "./words";

export function PageHead({
  tile,
  title,
  status,
  actions,
  lede,
  compact,
}: {
  tile: ReactNode;
  title: string;
  /** The line under the name: "Synced 5 min ago · every hour · read-only". */
  status?: { tone: Status["tone"]; text: string } | null;
  /** Buttons; null draws none. */
  actions?: ReactNode;
  lede?: string | null;
  compact: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const withStatus = status !== undefined && status !== null;
  return (
    <View testID="data-page-head">
      <View style={[styles.row, withStatus ? styles.rowTop : styles.rowCentre]}>
        {tile}
        <View style={styles.titleBox}>
          <Text style={[styles.title, compact && styles.titleCompact]} role="heading" aria-level={2} numberOfLines={1}>
            {title}
          </Text>
          {withStatus ? (
            <View style={styles.status}>
              {status.tone === "bad" ? <WarnGlyph size={11} /> : <StatusDot tone={status.tone} />}
              <Text style={[styles.statusText, compact && styles.statusCompact, status.tone === "bad" && styles.bad]} numberOfLines={compact ? 2 : 1}>
                {status.text}
              </Text>
            </View>
          ) : null}
        </View>
        {compact || actions === undefined || actions === null ? null : <View style={[styles.buttons, withStatus && styles.buttonsTop]}>{actions}</View>}
      </View>
      {compact ? (
        actions === undefined || actions === null ? <View style={styles.phoneGap} /> : <View style={styles.phoneButtons}>{actions}</View>
      ) : lede === undefined || lede === null || lede === "" ? (
        <View style={withStatus ? styles.gapWithStatus : styles.gap} />
      ) : (
        <Text style={[styles.lede, withStatus && styles.ledeWithStatus]}>{lede}</Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", gap: 12 },
    rowCentre: { alignItems: "center", minHeight: 40 },
    rowTop: { alignItems: "flex-start" },
    titleBox: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    title: { fontSize: pointerType.h2, lineHeight: 30, fontWeight: "600", letterSpacing: -0.4, color: colors.text },
    titleCompact: { fontSize: touchType.h2, lineHeight: 28 },
    status: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
    statusText: { fontSize: pointerType.meta, lineHeight: 18, color: colors.muted, flexShrink: 1 },
    statusCompact: { fontSize: pointerType.meta },
    bad: { color: colors.critText },
    buttons: { flexDirection: "row", gap: 8, flexShrink: 0 },
    buttonsTop: { marginTop: 2 },
    phoneButtons: { flexDirection: "row", gap: 8, marginTop: 10, marginBottom: 14 },
    phoneGap: { height: 14 },
    lede: { fontSize: pointerType.lede, lineHeight: 20, color: colors.muted, marginTop: 6, marginBottom: 26 },
    ledeWithStatus: { marginTop: 10, marginBottom: 22 },
    gap: { height: 26 },
    gapWithStatus: { height: 22 },
  });

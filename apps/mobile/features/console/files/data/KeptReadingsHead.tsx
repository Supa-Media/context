/**
 * The Readings header of a right-now metric inside the signed-in console: "kept every hour · read 12 min ago" once
 * the sync keeps it, or "right now only" with Keep every hour for an editor, and the last run's sentence when it
 * failed or stopped (`useMetricKeep.ts`, `docs/decisions/data-and-metrics.md`, "Right-now metrics are kept hourly").
 *
 * Its own component so that only a page in the console asks the gateway: a demo or a test without the console's
 * data draws the plain header in `MetricNoteView.tsx` and never reaches for a grant.
 */

import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { SectionLink } from "./Parts";
import { Words } from "./SourceParts";
import { useMetricKeep } from "./useMetricKeep";
import { ago } from "./words";

export function KeptReadingsHead({
  path,
  keptExists,
  settled,
  now,
  onKept,
}: {
  path: string;
  /** Whether the kept sheet was read: Keep every hour makes it only when it was not. */
  keptExists: boolean;
  /** The page's reads have landed; until then Keep every hour is not offered. */
  settled: boolean;
  now: number;
  /** After a keep: read the kept sheet again. */
  onKept: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const keeping = useMetricKeep(path, true);
  const [said, setSaid] = useState<string | null>(null);
  const keep = keeping.keep;
  const press = useCallback(() => {
    if (keep === undefined) return;
    setSaid(null);
    void keep(keptExists).then((why) => {
      setSaid(why);
      onKept();
    });
  }, [keep, keptExists, onKept]);
  const state = keeping.state;
  const last = said ?? (state?.failedAt !== undefined || state?.stopped === true ? (state?.said ?? null) : null);
  return (
    <>
      <View style={styles.head}>
        <Text style={styles.h3}>Readings</Text>
        {keeping.armed ? (
          <Text style={styles.from}>{state?.syncedAt === undefined ? "kept every hour" : `kept every hour · read ${ago(state.syncedAt, now)}`}</Text>
        ) : (
          <View style={styles.keepRow}>
            <Text style={styles.fromInline}>right now only</Text>
            {keep === undefined || !settled ? null : <SectionLink label="Keep every hour" onPress={press} />}
          </View>
        )}
      </View>
      {last !== null ? (
        <View style={styles.said}>
          <Words text={last} quiet small />
        </View>
      ) : null}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "baseline", gap: 10, marginBottom: 10 },
    h3: { fontSize: pointerType.h3, lineHeight: 26, fontWeight: "600", color: colors.text },
    from: { marginLeft: "auto", fontSize: pointerType.meta, color: colors.muted },
    keepRow: { marginLeft: "auto", flexDirection: "row", alignItems: "baseline", gap: 10 },
    fromInline: { fontSize: pointerType.meta, color: colors.muted },
    said: { marginTop: -4, marginBottom: 10 },
  });

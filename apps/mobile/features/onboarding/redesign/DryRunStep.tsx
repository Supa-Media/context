import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { fonts, leading, radii, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * B1-02 — the dry-run report.
 *
 * The person handed us S3 credentials and pointed at a bucket. Before we
 * write a single byte we say what we saw: how many objects, whether it looks
 * empty, whether it looks like an Obsidian vault, whether a `.context`
 * manifest already exists (which means somebody has run this before). The
 * two buttons close the loop honestly — continue only if this is the bucket
 * you meant.
 */
export interface DryRunFinding {
  key: string;
  label: string;
  value: string;
  tone: "ok" | "warn" | "neutral";
}

export function DryRunStep({
  bucket,
  region,
  findings,
  looksReady,
  onContinue,
  onShowFolder,
  onBack,
}: {
  bucket: string;
  region: string;
  findings: readonly DryRunFinding[];
  looksReady: boolean;
  onContinue: () => void;
  onShowFolder: () => void;
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        We listed your bucket, read-only. Nothing has been written, moved, or
        renamed. Here is what we saw.
      </Text>

      <View style={styles.head}>
        <View style={styles.address}>
          <Text style={styles.addrLabel}>Bucket</Text>
          <Text style={styles.addrValue}>{bucket}</Text>
        </View>
        <View style={styles.address}>
          <Text style={styles.addrLabel}>Region</Text>
          <Text style={styles.addrValue}>{region}</Text>
        </View>
        <View style={styles.address}>
          <Pill tone={looksReady ? "ok" : "warn"}>
            {looksReady ? "Looks ready" : "Worth a second look"}
          </Pill>
        </View>
      </View>

      <View style={styles.list}>
        {findings.map((finding) => (
          <View key={finding.key} style={styles.row}>
            <View style={styles.rowLabel}>
              <Text style={styles.rowLabelText}>{finding.label}</Text>
            </View>
            <View style={styles.rowValue}>
              <Text style={styles.rowValueText}>{finding.value}</Text>
              <Pill tone={finding.tone}>
                {toneLabel(finding.tone)}
              </Pill>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Button label="Back" variant="ghost" onPress={onBack} />
        <Button label="Show me a folder" variant="ghost" onPress={onShowFolder} />
        <Button
          label={looksReady ? "Looks right — continue" : "Continue anyway"}
          variant="white"
          onPress={onContinue}
        />
      </View>
    </View>
  );
}

function toneLabel(tone: "ok" | "warn" | "neutral"): string {
  switch (tone) {
    case "ok":
      return "OK";
    case "warn":
      return "Note";
    case "neutral":
      return "—";
  }
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: {
      marginBottom: space.x5,
      lineHeight: leading(12.5, 1.7),
      color: colors.text2,
    },
    head: {
      gap: space.x3,
      marginBottom: space.x5,
    },
    address: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    addrLabel: {
      fontFamily: fonts.body,
      fontSize: t.label,
      color: colors.muted,
      textTransform: "uppercase",
      letterSpacing: tracking(11.5, 0.06),
      fontWeight: "600",
      minWidth: 60,
    },
    addrValue: {
      fontFamily: fonts.mono,
      fontSize: t.ui,
      color: colors.text,
      flex: 1,
    },
    list: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: space.x4,
      paddingVertical: space.x3,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    rowLabel: {
      minWidth: 110,
    },
    rowLabelText: {
      fontFamily: fonts.body,
      fontSize: t.meta,
      color: colors.muted,
    },
    rowValue: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
    },
    rowValueText: {
      fontFamily: fonts.body,
      fontSize: t.meta,
      color: colors.text,
      fontWeight: "500",
      flex: 1,
    },
    actions: {
      marginTop: space.x6,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      flexWrap: "wrap",
    },
  });

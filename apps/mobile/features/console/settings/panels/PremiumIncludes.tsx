import { StyleSheet, View } from "react-native";
import { Card } from "../../../design/components/Card";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { formatBytes, premiumStateOf, type PremiumStatus } from "./premium";

/**
 * "What Premium includes", now that Premium is one plan (decided 2026-09-28,
 * `docs/decisions/billing.md`, "One plan").
 *
 * There is nothing to tick before paying: the Upgrade button buys all of it,
 * and the control plane fills in the selection (`selectionAtUpgrade`). So this
 * is a list, read the same way by an owner, a member and the demo. It has no
 * switches.
 *
 * Fast search is no longer part of Premium. Since 2026-10-08 it is on for every
 * workspace, free or paid, and the owner can still switch it off under Storage
 * & search, so it is not listed here at all.
 */
export interface IncludeRow {
  key: "notes" | "domain";
  label: string;
  detail: string;
}

export function premiumIncludeRows(status: PremiumStatus): IncludeRow[] {
  const rows: IncludeRow[] = [];
  // Only where the notes live on a bucket we run. The owner's own storage has
  // no cap of ours to lift, and paying never moves it.
  if (status.storageIsManaged || status.selected.managedStorage) {
    rows.push({
      key: "notes",
      label: "Unlimited notes",
      detail: `Room for ${formatBytes(status.ceilingBytes)}, far more than most people ever write.`,
    });
  }
  rows.push({
    key: "domain",
    label: "Your own domain",
    detail: "Links and your website open at an address like docs.acme.com.",
  });
  return rows;
}

export function PremiumIncludes({ status }: { status: PremiumStatus }) {
  const styles = useThemedStyles(makeStyles);
  const paying = premiumStateOf(status.status) === "premium";

  return (
    <Card style={styles.card} testID="premium-includes">
      <Text variant="eyebrow">What Premium includes</Text>
      {premiumIncludeRows(status).map((row) => (
        <View key={row.key} style={styles.row}>
          <View style={styles.head}>
            <Text variant="rowTitle">{row.label}</Text>
            {paying ? <Pill tone="ok">Included</Pill> : null}
          </View>
          <Text variant="rowSub" style={styles.blurb}>
            {row.detail}
          </Text>
        </View>
      ))}
    </Card>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    card: { marginTop: 12 },
    row: { marginTop: 14 },
    head: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    blurb: { marginTop: 4 },
  });

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Card } from "../../../design/components/Card";
import { Pill } from "../../../design/components/Pill";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { formatBytes, premiumStateOf, type PremiumStatus } from "./premium";
import { entitlementRows } from "./premiumEntitlements";

/**
 * "What Premium includes", now that Premium is one plan (decided 2026-09-28,
 * `docs/decisions/billing.md`, "One plan").
 *
 * There is nothing to tick before paying: the Upgrade button buys all of it,
 * and the control plane fills in the selection (`selectionAtUpgrade`). So this
 * is a list, read the same way by an owner, a member and the demo, and the
 * only switch is the search index, offered to an owner once they are paying,
 * for people who do not want a copy of their notes' text on our servers.
 *
 * Auto-organize is not a row here: its own line (`IncludedLine`) is handed in
 * as `extra`, because only the organizer knows whether it is switched on for
 * this deployment, and a row saying it was included where it is not would be
 * selling something that does not arrive.
 */
export interface IncludeRow {
  key: "notes" | "fastSearch" | "domain";
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
  rows.push(
    {
      key: "fastSearch",
      label: "Fast search",
      detail: "Results as you type, across every note.",
    },
    {
      key: "domain",
      label: "Your own domain",
      detail: "Links and your website open at an address like docs.acme.com.",
    },
  );
  return rows;
}

export const SEARCH_INDEX_COPY =
  "Fast search stores a searchable copy of your notes' text on our servers. " +
  "Turn it off to keep that copy off our servers. Search still works, just slower.";

export const SEARCH_INDEX_KEPT =
  "On your own storage, Premium keeps the index on. To stop paying, use Manage billing.";

export function PremiumIncludes({
  status,
  onSearchIndex,
  disabled = false,
  extra,
}: {
  status: PremiumStatus;
  /** Present for an owner of a paying context; absent everywhere else. */
  onSearchIndex?: (next: boolean) => void;
  disabled?: boolean;
  /** Auto-organize's line, where the organizer offers it. */
  extra?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const paying = premiumStateOf(status.status) === "premium";
  // The last selected entitlement is locked (#1098), and on the owner's own
  // storage that is the index. Said, rather than drawn as a switch that is
  // then refused.
  const indexLocked =
    entitlementRows(status).find((row) => row.value === "fastSearch")?.locked === true;

  return (
    <Card style={styles.card} testID="premium-includes">
      <Text variant="eyebrow">What Premium includes</Text>
      {premiumIncludeRows(status).map((row) => (
        <View key={row.key} style={styles.row}>
          <View style={styles.head}>
            <Text variant="rowTitle">{row.label}</Text>
            {paying && (row.key !== "fastSearch" || status.selected.fastSearch) ? (
              <Pill tone="ok">Included</Pill>
            ) : null}
          </View>
          <Text variant="rowSub" style={styles.blurb}>
            {row.detail}
          </Text>
        </View>
      ))}
      {extra ?? null}
      {paying && onSearchIndex !== undefined ? (
        <View style={[styles.row, styles.divided]} testID="premium-search-index">
          <View style={styles.head}>
            <Text variant="rowTitle">Search index</Text>
            <Switch
              value={status.selected.fastSearch}
              onValueChange={onSearchIndex}
              label="Search index"
              disabled={disabled || indexLocked}
              testID="premium-search-index-switch"
            />
          </View>
          <Text variant="rowSub" style={styles.blurb}>
            {indexLocked ? `${SEARCH_INDEX_COPY} ${SEARCH_INDEX_KEPT}` : SEARCH_INDEX_COPY}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    card: { marginTop: 12 },
    row: { marginTop: 14 },
    divided: { paddingTop: 14 },
    head: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    blurb: { marginTop: 4 },
  });

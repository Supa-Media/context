import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Pill } from "../../../design/components/Pill";
import { TextLink } from "../../../design/components/TextLink";
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
 * switches: the search index used to have one here as well as the one under
 * Storage & search, two controls for one question, so a paying owner is now
 * pointed at that one instead.
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
  "Fast search keeps a searchable copy of your notes' text on our servers. " +
  "Turn it on or off under Storage & search.";

export function PremiumIncludes({
  status,
  onOpenSearch,
  onIncludeSearch,
  disabled = false,
  extra,
}: {
  status: PremiumStatus;
  /** Opens Storage & search, where the index's one switch lives. */
  onOpenSearch?: () => void;
  /**
   * Puts fast search back into the plan. Only for a paying owner whose plan
   * left it out, which the old switch here could do: without this, Storage &
   * search reads "unavailable" for them and nothing anywhere turns it back on.
   */
  onIncludeSearch?: () => void;
  disabled?: boolean;
  /** Auto-organize's line, where the organizer offers it. */
  extra?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const paying = premiumStateOf(status.status) === "premium";

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
      {paying && status.canManage && !status.selected.fastSearch && onIncludeSearch !== undefined ? (
        <View style={[styles.row, styles.divided]} testID="premium-search-index">
          <Text variant="rowSub">
            Fast search is left out of this workspace&apos;s plan, so search reads your own
            storage.
          </Text>
          <Button
            label="Include fast search"
            variant="mini"
            disabled={disabled}
            onPress={onIncludeSearch}
            style={styles.include}
            testID="premium-include-search"
          />
        </View>
      ) : paying && status.canManage ? (
        <View style={[styles.row, styles.divided]} testID="premium-search-index">
          <Text variant="rowSub">{SEARCH_INDEX_COPY}</Text>
          {onOpenSearch === undefined ? null : (
            <TextLink
              label="Open Storage & search"
              onPress={onOpenSearch}
              testID="premium-open-search"
            />
          )}
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
    include: { marginTop: 10, alignSelf: "flex-start" },
  });

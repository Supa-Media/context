/**
 * The AI costs tab's three tables: what each feature cost, what each model
 * cost, and which accounts spent it. Each is a table on a pointer and a list
 * on a phone, the way every console table is (`./AdminTable`).
 *
 * The arithmetic is in `./aiCosts`; these only lay out what it returns.
 */

import { Pressable, StyleSheet, View } from "react-native";
import type { AiCostsReport } from "@context/convex/functions/lib/adminFns/aiCostsShape";
import { Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import { ListRow, RowValue, TableHead, TableRow, type Column } from "./AdminTable";
import { Swatch, SplitBar } from "./AiCostsParts";
import {
  featureName,
  formatDollars,
  modelNames,
  moreAccountsLine,
  priceLine,
  questionsLine,
  splitByFeature,
  usesLine,
  type FeatureRow,
} from "./aiCosts";
import { formatCount } from "./report";

// -- by feature -----------------------------------------------------------

const FEATURE_COLUMNS: readonly Column[] = [
  { label: "Feature", flex: 2.4 },
  { label: "Model", flex: 1.7 },
  { label: "Uses", flex: 1.4, align: "right" },
  { label: "Each", flex: 0.9, align: "right" },
  { label: "Cost", flex: 0.9, align: "right" },
];

export function FeatureTable({ rows }: { rows: readonly FeatureRow[] }) {
  const compact = useCompact();
  if (rows.length === 0) return <Empty text="Nothing was spent on a feature in this window." />;
  return (
    <View testID="ai-costs-features">
      {compact ? null : <TableHead columns={FEATURE_COLUMNS} />}
      {rows.map((row, index) => (
        <FeatureLine key={row.feature} row={row} first={index === 0} last={index === rows.length - 1} compact={compact} />
      ))}
    </View>
  );
}

function FeatureLine({ row, first, last, compact }: { row: FeatureRow; first: boolean; last: boolean; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const name = <FeatureName row={row} />;
  const each = row.eachUsd === null ? "—" : formatDollars(row.eachUsd);
  if (compact) {
    return (
      <ListRow
        first={first}
        title={name}
        sub={`${modelNames(row.models)} · ${row.eachUsd === null ? usesLine(row.uses, row.unit) : `${each} each`}`}
        trailing={<RowValue>{formatDollars(row.costUsd)}</RowValue>}
        testID={`ai-costs-feature-${row.feature}`}
      />
    );
  }
  return (
    <TableRow
      columns={FEATURE_COLUMNS}
      last={last}
      testID={`ai-costs-feature-${row.feature}`}
      cells={[
        name,
        <Text key="model" variant="rowSub" numberOfLines={1}>
          {modelNames(row.models)}
        </Text>,
        <Text key="uses" style={styles.num}>
          {usesLine(row.uses, row.unit)}
        </Text>,
        <Text key="each" style={styles.num}>
          {each}
        </Text>,
        <Text key="cost" style={styles.num}>
          {formatDollars(row.costUsd)}
        </Text>,
      ]}
    />
  );
}

/** A feature's colour, its name, and the "no account" pill for a Cloudflare-only one. */
function FeatureName({ row }: { row: FeatureRow }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.nameRow}>
      <Swatch tone={row.tone} />
      <Text variant="rowTitle" numberOfLines={1} style={styles.nameText}>
        {featureName(row.feature, row.label)}
      </Text>
      {row.noAccount ? (
        <Pill tone="neutral" testID={`ai-costs-no-account-${row.feature}`}>
          no account
        </Pill>
      ) : null}
    </View>
  );
}

// -- by model -------------------------------------------------------------

const MODEL_COLUMNS: readonly Column[] = [
  { label: "Model", flex: 2 },
  { label: "Tokens in", flex: 1, align: "right" },
  { label: "Tokens out", flex: 1, align: "right" },
  { label: "Price per million", flex: 1.8, align: "right" },
  { label: "Cost", flex: 0.9, align: "right" },
];

export function ModelTable({ report }: { report: AiCostsReport }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const { models, unrecordedModelUsd } = report;
  const unrecorded = unrecordedModelUsd > 0;
  if (models.length === 0 && !unrecorded) return <Empty text="No model was recorded in this window." />;
  const lines = [
    ...models.map((entry) => ({
      key: entry.model,
      name: entry.label,
      tokensIn: entry.inputTokens,
      tokensOut: entry.outputTokens,
      price: priceLine(entry.price),
      cost: entry.costUsd,
    })),
    ...(unrecorded
      ? [{ key: "unrecorded", name: "Before models were recorded", tokensIn: 0, tokensOut: 0, price: "—", cost: unrecordedModelUsd }]
      : []),
  ];
  return (
    <View testID="ai-costs-models">
      {compact ? null : <TableHead columns={MODEL_COLUMNS} />}
      {lines.map((line, index) => {
        const last = index === lines.length - 1;
        const cost = formatDollars(line.cost);
        if (compact) {
          return (
            <ListRow
              key={line.key}
              first={index === 0}
              title={line.name}
              sub={line.price === "—" ? undefined : line.price}
              trailing={<RowValue>{cost}</RowValue>}
              testID={`ai-costs-model-${line.key}`}
            />
          );
        }
        return (
          <TableRow
            key={line.key}
            columns={MODEL_COLUMNS}
            last={last}
            testID={`ai-costs-model-${line.key}`}
            cells={[
              <Text key="name" variant="rowTitle" numberOfLines={1}>
                {line.name}
              </Text>,
              <Text key="in" style={styles.num}>
                {line.tokensIn > 0 ? formatCount(line.tokensIn) : "—"}
              </Text>,
              <Text key="out" style={styles.num}>
                {line.tokensOut > 0 ? formatCount(line.tokensOut) : "—"}
              </Text>,
              <Text key="price" variant="rowSub">
                {line.price}
              </Text>,
              <Text key="cost" style={styles.num}>
                {cost}
              </Text>,
            ]}
          />
        );
      })}
    </View>
  );
}

// -- who it was spent on --------------------------------------------------

const ACCOUNT_COLUMNS: readonly Column[] = [
  { label: "Account", flex: 2.2 },
  { label: "Cost", flex: 0.9, align: "right" },
  { label: "Split by feature", flex: 2 },
  { label: "Questions today", flex: 1.2, align: "right" },
];

export function AccountTable({
  accounts,
  moreAccounts,
  onOpen,
}: {
  accounts: AiCostsReport["accounts"];
  moreAccounts: number;
  onOpen: (userId: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  if (accounts.length === 0) return <Empty text="No account spent anything in this window." />;
  return (
    <View testID="ai-costs-accounts">
      {compact ? null : <TableHead columns={ACCOUNT_COLUMNS} />}
      {accounts.map((account, index) => {
        const press = {
          role: "button" as const,
          "aria-label": `${accountName(account)}, ${formatDollars(account.costUsd)}`,
          onPress: () => onOpen(account.userId),
          testID: `ai-costs-account-${account.userId}`,
        };
        if (compact) {
          return (
            <Pressable key={account.userId} {...press}>
              <ListRow
                first={index === 0}
                title={accountName(account)}
                sub={`${questionsLine(account.questionsToday, account.questionsCap)} questions today`}
                trailing={<RowValue>{formatDollars(account.costUsd)} ›</RowValue>}
              />
            </Pressable>
          );
        }
        return (
          <Pressable key={account.userId} {...press}>
            <TableRow
              columns={ACCOUNT_COLUMNS}
              last={index === accounts.length - 1 && moreAccounts === 0}
              cells={[
                <View key="who">
                  <Text variant="rowTitle" numberOfLines={1}>
                    {accountName(account)}
                  </Text>
                  <Text variant="meta" numberOfLines={1}>
                    {accountSub(account)}
                  </Text>
                </View>,
                <Text key="cost" style={styles.num}>
                  {formatDollars(account.costUsd)}
                </Text>,
                <SplitBar key="split" parts={splitByFeature(account.byFeature)} />,
                <Text key="today" style={styles.num}>
                  {questionsLine(account.questionsToday, account.questionsCap)}
                </Text>,
              ]}
            />
          </Pressable>
        );
      })}
      {moreAccounts > 0 ? (
        <View style={styles.more}>
          <Text style={styles.moreText} testID="ai-costs-more-accounts">
            {moreAccountsLine(moreAccounts)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function accountName(account: { email: string | null; userId: string }): string {
  return account.email ?? "No email on file";
}

function accountSub(account: { plan: string; workspaces: number }): string {
  return `${account.plan} · ${account.workspaces} ${account.workspaces === 1 ? "workspace" : "workspaces"}`;
}

function Empty({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="meta" style={styles.empty}>
      {text}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    num: { fontSize: pointerType.lede, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
    nameRow: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0, maxWidth: "100%" },
    nameText: { flexShrink: 1 },
    more: { paddingHorizontal: space.x5, paddingVertical: space.x3 },
    moreText: { fontSize: pointerType.meta, fontWeight: "600", color: colors.accentText },
    empty: { paddingHorizontal: space.x5, paddingVertical: space.x4 },
  });

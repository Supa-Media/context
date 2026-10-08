/**
 * One account's AI costs, opened from the accounts table: what it cost against
 * what it pays, the day's use against today's limits, and each workspace,
 * feature and model it was spent on.
 *
 * Wide, this is the side drawer `AiCostsSection` draws beside the page; on a
 * phone it is the whole screen, with a back control. It shows numbers only,
 * and says so: no question, answer or note is read for it.
 */

import { Pressable, StyleSheet, View } from "react-native";
import type { AiCostsAccount as AccountShape } from "@context/convex/functions/lib/adminFns/aiCostsShape";
import { Card, Text, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, Skeleton, useCompact } from "./AdminKit";
import { ListRow, RowValue, TableHead, TableRow, type Column } from "./AdminTable";
import { MeterBar, SubHead } from "./AiCostsParts";
import {
  featureName,
  featureTone,
  formatDollars,
  modelNames,
  planHeadline,
  planShareLine,
  todayLine,
  workspaceLabel,
} from "./aiCosts";
import { formatCount, shortDay } from "./report";

type AccountRecord = NonNullable<AccountShape>;

export function AiCostsAccount({
  account,
  onClose,
}: {
  /** `undefined` while it loads; `null` when the account cannot be found. */
  account: AccountShape | undefined;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <View style={[styles.drawer, compact ? styles.full : styles.side]} testID="ai-costs-drawer">
      <Head account={account ?? null} compact={compact} onClose={onClose} loading={account === undefined} />
      <View style={[styles.body, compact && styles.bodyCompact]}>
        {account === undefined ? (
          <View aria-busy testID="ai-costs-drawer-loading">
            <Skeleton width="100%" height={70} />
            <Skeleton width="100%" height={120} style={styles.gap} />
          </View>
        ) : account === null ? (
          <EmptyNote title="Account not found" body="It may have been removed. Go back and pick another." />
        ) : (
          <Figures account={account} compact={compact} />
        )}
      </View>
    </View>
  );
}

function Head({
  account,
  compact,
  onClose,
  loading,
}: {
  account: AccountRecord | null;
  compact: boolean;
  onClose: () => void;
  loading: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const email = account?.email ?? "No email on file";
  return (
    <View style={[styles.head, compact && styles.headCompact]}>
      {compact ? (
        <Pressable role="button" aria-label="Back to AI costs" onPress={onClose} hitSlop={10} testID="ai-costs-drawer-back">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
      ) : null}
      {account && !compact ? <Avatar letter={email.charAt(0)} /> : null}
      <View style={styles.headText}>
        {loading ? null : (
          <>
            <Text variant="rowTitle" numberOfLines={1}>
              {email}
            </Text>
            {account ? (
              <Text variant="meta" numberOfLines={1}>
                {planHeadline(account.plan, account.planUsd)}
              </Text>
            ) : null}
          </>
        )}
      </View>
      {compact ? null : (
        <Pressable role="button" aria-label="Close" onPress={onClose} hitSlop={10} testID="ai-costs-drawer-close" style={styles.close}>
          <Text style={styles.closeGlyph} aria-hidden>
            ×
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function Avatar({ letter }: { letter: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.avatar} aria-hidden>
      <Text style={styles.avatarLetter}>{letter.toUpperCase()}</Text>
    </View>
  );
}

function Figures({ account, compact }: { account: AccountRecord; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const share = planShareLine(account.totalUsd, account.planUsd);
  const columns: readonly Column[] = [
    { label: "Workspace", flex: 1.1 },
    { label: "Feature", flex: 1.4 },
    { label: "Model", flex: 1.5 },
    { label: "Cost", flex: 0.8, align: "right" },
  ];
  return (
    <View style={styles.figures}>
      <View style={styles.tiles}>
        <Figure label={`AI, ${account.days} days`} value={formatDollars(account.totalUsd)} sub={share ?? "Not paying"} testID="ai-costs-drawer-spent" />
        <Figure
          label="Questions texted"
          value={formatCount(account.questionsTexted)}
          sub={account.perQuestionUsd === null ? "—" : `${formatDollars(account.perQuestionUsd)} each`}
          testID="ai-costs-drawer-questions"
        />
        <Figure
          label="Busiest day"
          value={account.busiestDay === null ? "—" : formatDollars(account.busiestDay.costUsd)}
          sub={account.busiestDay === null ? "No spend" : shortDay(account.busiestDay.day)}
          testID="ai-costs-drawer-busiest"
        />
      </View>

      {account.today.length > 0 ? (
        <View style={styles.today} testID="ai-costs-drawer-today">
          {account.today.map((item) => {
            const line = todayLine(item);
            return (
              <View key={item.feature} style={styles.todayItem}>
                <Text variant="check">{line.text}</Text>
                <MeterBar fraction={line.fraction} tone={featureTone(item.feature)} />
              </View>
            );
          })}
        </View>
      ) : null}

      <SubHead first>By workspace</SubHead>
      {account.rows.length === 0 ? (
        <Text variant="meta" style={styles.empty}>
          Nothing was spent in this window.
        </Text>
      ) : compact ? (
        account.rows.map((row, index) => (
          <ListRow
            key={`${row.workspace}-${row.feature}-${index}`}
            first={index === 0}
            title={workspaceLabel(row.workspace)}
            sub={`${featureName(row.feature, row.label)} · ${modelNames(row.models)}`}
            trailing={<RowValue>{formatDollars(row.costUsd)}</RowValue>}
            testID={`ai-costs-drawer-row-${index}`}
          />
        ))
      ) : (
        <View>
          <TableHead columns={columns} />
          {account.rows.map((row, index) => (
            <TableRow
              key={`${row.workspace}-${row.feature}-${index}`}
              columns={columns}
              last={index === account.rows.length - 1}
              testID={`ai-costs-drawer-row-${index}`}
              cells={[
                <Text key="ws" variant="rowTitle" numberOfLines={1}>
                  {workspaceLabel(row.workspace)}
                </Text>,
                <Text key="feature" variant="rowSub" numberOfLines={1}>
                  {featureName(row.feature, row.label)}
                </Text>,
                <Text key="model" variant="rowSub" numberOfLines={2}>
                  {modelNames(row.models)}
                </Text>,
                <Text key="cost" style={styles.num}>
                  {formatDollars(row.costUsd)}
                </Text>,
              ]}
            />
          ))}
        </View>
      )}

      <Text variant="foot" style={styles.foot}>
        Numbers only. No question, answer or note is kept for this page.
      </Text>
    </View>
  );
}

function Figure({ label, value, sub, testID }: { label: string; value: string; sub: string; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.figure} testID={testID}>
      <Text variant="meta">{label}</Text>
      <Text style={styles.figureValue} numberOfLines={1}>
        {value}
      </Text>
      <Text variant="meta" numberOfLines={2}>
        {sub}
      </Text>
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    drawer: { backgroundColor: colors.surface, minHeight: 0 },
    side: { width: 420, flexShrink: 0, borderLeftWidth: 1, borderLeftColor: colors.line },
    full: { flex: 1, width: "100%", backgroundColor: colors.ground },
    head: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingHorizontal: space.x5, paddingTop: space.x5, paddingBottom: space.x3 },
    headCompact: { paddingHorizontal: space.x4, paddingTop: space.x3 },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface3,
    },
    avatarLetter: { fontSize: pointerType.ui, fontWeight: "600", color: colors.text2 },
    back: { fontSize: pointerType.lede, fontWeight: "500", color: colors.accentText },
    close: { paddingHorizontal: 4 },
    closeGlyph: { fontSize: pointerType.title, lineHeight: leading(pointerType.title, 1), color: colors.muted },
    body: { paddingHorizontal: space.x5, paddingBottom: space.x5, gap: space.x4 },
    bodyCompact: { paddingHorizontal: space.x4 },
    gap: { marginTop: space.x3 },
    figures: { gap: space.x4 },
    tiles: { flexDirection: "row", gap: space.x2 },
    figure: { flex: 1, minWidth: 0, paddingVertical: space.x3, paddingHorizontal: space.x3, gap: 4 },
    figureValue: {
      fontSize: pointerType.lede,
      lineHeight: leading(pointerType.lede, 1.2),
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    today: { gap: space.x3 },
    todayItem: { gap: 6 },
    num: { fontSize: pointerType.ui, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
    empty: { paddingVertical: space.x3 },
    foot: { marginTop: space.x2 },
  });

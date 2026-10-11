/**
 * The AI costs tab, as one screen: what AI cost, which feature and model it
 * went to, and which accounts it was spent on.
 *
 * Wide, it is four headline tiles, the Cloudflare check, and two panels side
 * by side: each day by feature with the feature and model tables under it, and
 * the accounts. On a phone it is the tiles two across and then two plain
 * lists, features and accounts, as the owner's phone mockup has it.
 *
 * Presentational: the data comes in as props from `./AiCostsSection`, which
 * gets it from `./aiCostsData`. The arithmetic is in `./aiCosts`.
 */

import { StyleSheet, View } from "react-native";
import type { AiCostsCloudflare, AiCostsReport } from "@context/convex/functions/lib/adminFns/aiCostsShape";
import { Card, Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, NoticeLine, Panel, Skeleton, TwoUp, usePanelPad, useCompact } from "./AdminKit";
import { AiCostsDays } from "./AiCostsDays";
import { AccountTable, FeatureTable, ModelTable } from "./AiCostsTables";
import { CostTile, SubHead } from "./AiCostsParts";
import {
  changeLine,
  changeTone,
  checkLine,
  formatDollars,
  mergeFeatures,
  mostExpensive,
  mostExpensiveLine,
  perAccountLine,
  tallestDayLine,
  type FeatureRow,
} from "./aiCosts";
import { formatCount } from "./report";

export interface AiCostsViewProps {
  /** `undefined` while the report loads. */
  report: AiCostsReport | undefined;
  /** `undefined` while Cloudflare's count loads; `configured: false` when no token is set. */
  cloudflare: AiCostsCloudflare | undefined;
  onOpenAccount: (userId: string) => void;
}

export function AiCostsView({ report, cloudflare, onOpenAccount }: AiCostsViewProps) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const pad = usePanelPad();
  if (report === undefined) return <Loading />;

  const rows = mergeFeatures(report.features, cloudflare);
  const top = mostExpensive(rows);
  const assistant = rows.find((row) => row.feature === "assistant");
  const trend = changeTone(report.totalUsd, report.priorUsd);

  return (
    <View style={styles.section} testID="admin-ai-costs">
      {report.truncated ? (
        <NoticeLine mark="!" tone="warn">
          This window has more activity than the tab reads at once, so these totals are a floor.
        </NoticeLine>
      ) : null}

      <View style={[styles.tiles, compact && styles.tilesCompact]}>
        <CostTile
          label="Spent on AI"
          value={formatDollars(report.totalUsd)}
          sub={changeLine(report.totalUsd, report.priorUsd, report.days)}
          tone={trend}
          testID="ai-costs-tile-spent"
        />
        <CostTile
          label="Per paying account"
          value={report.perPayingAccountUsd === null ? "—" : formatDollars(report.perPayingAccountUsd)}
          sub={report.payingAccounts === 0 ? "No paying accounts yet" : perAccountLine(report.payingAccounts)}
          testID="ai-costs-tile-per-account"
        />
        <CostTile
          label="Most expensive feature"
          value={top === null ? "—" : top.label}
          sub={top === null ? "Nothing spent yet" : mostExpensiveLine(top)}
          small
          testID="ai-costs-tile-top-feature"
        />
        <CostTile
          label="Each texted question"
          value={report.perQuestionUsd === null ? "—" : formatDollars(report.perQuestionUsd)}
          sub={`${formatCount(report.textedQuestions)} ${report.textedQuestions === 1 ? "question" : "questions"} · ${formatDollars(assistant?.costUsd ?? 0)} in all`}
          testID="ai-costs-tile-per-question"
        />
      </View>

      {cloudflare === undefined ? null : <CloudflareCheck cloudflare={cloudflare} rows={rows} />}

      {report.totalUsd === 0 && rows.length === 0 ? (
        <Card>
          <EmptyNote title="No AI spend in this window" body="Costs appear here as soon as an AI feature runs." />
        </Card>
      ) : compact ? (
        <View style={styles.stack}>
          <SubHead first>By feature</SubHead>
          <FeatureTable rows={rows} />
          <SubHead>Who it was spent on</SubHead>
          <AccountTable accounts={report.accounts} moreAccounts={report.moreAccounts} onOpen={onOpenAccount} />
        </View>
      ) : (
        <TwoUp>
          <Panel flush title="Each day, by feature" meta={tallestDayLine(report.daily)} testID="ai-costs-panel-days">
            <View style={{ paddingHorizontal: pad.x, paddingTop: pad.y }}>
              <AiCostsDays daily={report.daily} rows={rows} />
            </View>
            <SubHead>By feature</SubHead>
            <FeatureTable rows={rows} />
            <SubHead>By model</SubHead>
            <ModelTable report={report} />
          </Panel>
          <Panel flush title="Who it was spent on" meta="an account pays for the workspaces it owns" metaWide testID="ai-costs-panel-accounts">
            <AccountTable accounts={report.accounts} moreAccounts={report.moreAccounts} onOpen={onOpenAccount} />
          </Panel>
        </TwoUp>
      )}
    </View>
  );
}

/**
 * The strip that checks the figures against Cloudflare's own bill. It says
 * what was billed, what an account paid for, and what no account did.
 */
function CloudflareCheck({ cloudflare, rows }: { cloudflare: AiCostsCloudflare; rows: readonly FeatureRow[] }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  if (!cloudflare.configured) {
    return (
      <Card style={styles.strip} testID="ai-costs-check">
        <Text variant="check">Cloudflare's own count isn't connected yet</Text>
      </Card>
    );
  }
  if (cloudflare.error !== null) {
    return (
      <Card style={styles.strip} testID="ai-costs-check">
        <Text variant="check">Cloudflare could not be asked just now: {cloudflare.error}</Text>
      </Card>
    );
  }
  const check = checkLine(rows, cloudflare.billedUsd);
  const noAccount = rows.some((row) => row.noAccount);
  return (
    <Card style={styles.strip} testID="ai-costs-check">
      <View style={[styles.stripLine, compact && styles.stripLineCompact]}>
        <Text variant="check">Checked against Cloudflare's own count:</Text>
        <Text variant="check" style={styles.strong}>
          billed {formatDollars(check.billedUsd)}
        </Text>
        <Text variant="meta">·</Text>
        <Text variant="check">{formatDollars(check.linkedUsd)} linked to an account</Text>
        <Text variant="meta">·</Text>
        <Pill tone="warn" testID="ai-costs-not-linked">
          {formatDollars(check.notLinkedUsd)} not linked to an account
        </Pill>
      </View>
      {noAccount && !compact ? (
        <Text variant="meta" style={styles.stripNote}>
          Transcription and search by meaning aren't counted per account today
        </Text>
      ) : null}
    </Card>
  );
}

function Loading() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section} aria-busy testID="admin-ai-costs-loading">
      <View style={styles.tiles}>
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} style={styles.tile}>
            <Skeleton width={110} height={12} />
            <Skeleton width={150} height={26} style={styles.gap} />
            <Skeleton width="70%" height={12} />
          </Card>
        ))}
      </View>
      <Card>
        <Skeleton width={160} height={14} />
        <Skeleton width="100%" height={120} style={styles.gap} />
      </Card>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    stack: { gap: space.x2 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    tilesCompact: { gap: space.x3 },
    tile: { flexGrow: 1, flexBasis: 200, gap: 6 },
    strip: { paddingVertical: space.x3, paddingHorizontal: space.x4, gap: space.x2 },
    stripLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
    stripLineCompact: { gap: 6 },
    strong: { color: colors.text, fontWeight: "600" },
    stripNote: { marginTop: 2 },
    gap: { marginTop: 14 },
  });

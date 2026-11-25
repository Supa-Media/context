/**
 * A source's own folder page (boards 07, 09 and 10): what the folder holds —
 * about.md and each sheet with its columns, row count and last row — the
 * metrics that read it, and its settings as about.md has them.
 *
 * - A connected app says how it reads: Stripe's and Cloudflare's keys kept
 *   sealed by the sync, GitHub through Context's read-only App with no token
 *   kept; never in about.md (board 07).
 * - A push source lists its keys by name, never a key, and the call that
 *   sends a row with `$CONTEXT_KEY` (board 09); its keys come from the
 *   control plane and are drawn by `keys`.
 * - The built-in Context source shows which folders it counts and its latest
 *   rows (board 10); its sheets are worked out when read and are no files.
 */

import type { ReactNode } from "react";
import { View } from "react-native";
import { useColors } from "../../../design/theme";
import { countedFolders } from "./contextSource";
import { MoreGlyph, PlusGlyph, RefreshGlyph, SourceMark } from "./Marks";
import { MetricRows } from "./MetricRows";
import { PageHead } from "./PageHead";
import { DataButton, SectionHead, SectionLink } from "./Parts";
import { Code, CodeBlock, CodeCommand, CodeString, FileRows, MiniTable, PropsGrid, SettingsGrid, Words, type FileLine } from "./SourceParts";
import { textOf, USAGE_SHEETS, type DataSource } from "./sources";
import type { MetricView } from "./views";
import type { Sheet } from "./workOut";
import { ago, columnsWords, lastRowAt, lastRowWords, monthDay, rowsWords, settingsOf, sourceStatus, type SyncState } from "./words";

const ABOUT_LINE: Readonly<Record<string, string>> = {
  push: "Settings: the sheet's columns and who can make keys",
  context: "Which folders to count",
  fetch: "Settings: the address and the dataset",
};

const LEDE: Readonly<Record<string, string>> = {
  push: "Rows sent from your code. Anything with a key can add rows here; nothing can read them back with it.",
  context: "Context counts its own notes into these sheets. Which folders it counts is set in about.md.",
  fetch: "Context reads this address every hour and keeps what it answers in the sheet. It sends no key and no sign-in.",
};

export interface SourcePageActions {
  /** Sync now: a url source's, for an owner or editor (`dataSync.ts`); absent for anyone else, and not drawn. */
  readonly syncNow?: () => void;
  /** Connect again, for an app source (Stripe, Cloudflare, GitHub): its key form, or GitHub's install. Absent for anyone but an owner. */
  readonly reconnect?: () => void;
  /** Disconnect, for an app source: its key forgotten and its sync stopped. Absent for anyone but an owner. */
  readonly disconnect?: () => void;
  /** Repositories…, for GitHub: which of its installation's repositories it reads. Absent for anyone but an owner. */
  readonly repositories?: () => void;
  /** New key, for a push source: absent for someone who may not make one. */
  readonly newKey?: () => void;
  /** The folder's own menu, the ⋯ on the right. */
  readonly more?: (anchor: { x: number; y: number }) => void;
  readonly copy?: (text: string) => void;
}

/** The call that adds a row, its values made up from the sheet's columns: `$CONTEXT_KEY` stands for the key. */
export function sendRowCall(endpoint: string, sheet: Sheet | null): { text: string; lines: ReactNode[] } {
  // The sheet's own latest row where it has one, so the call reads like the data; else a value of each column's type.
  const last = sheet?.rows[sheet.rows.length - 1];
  const row: Record<string, string | number | boolean> = {};
  for (const column of sheet?.columns ?? []) {
    if (column.type === "date") continue;
    const kept = last?.[column.name] ?? "";
    const numeric = column.type === "number" || column.type === "usd";
    if (kept !== "" && numeric && Number.isFinite(Number(kept))) row[column.name] = Number(kept);
    else if (kept !== "" && !numeric && column.type !== "checkbox") row[column.name] = kept;
    else row[column.name] = numeric ? 1 : column.type === "checkbox" ? true : "…";
  }
  const body = `'${JSON.stringify({ rows: [row] })}'`;
  const text = [
    `curl -X POST ${endpoint} \\`,
    `  -H "Authorization: Bearer $CONTEXT_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${body}`,
  ].join("\n");
  const lines = [
    <>
      <CodeCommand text="curl" />
      {` -X POST ${endpoint} \\`}
    </>,
    <>
      {"  -H "}
      <CodeString text={'"Authorization: Bearer $CONTEXT_KEY"'} />
      {" \\"}
    </>,
    <>
      {"  -H "}
      <CodeString text={'"Content-Type: application/json"'} />
      {" \\"}
    </>,
    <>
      {"  -d "}
      <CodeString text={body} />
    </>,
  ];
  return { text, lines };
}

export function SourcePage({
  source,
  sheets,
  metrics,
  compact,
  now,
  sync,
  actions,
  keys,
  endpoint,
  onOpen,
}: {
  source: DataSource;
  sheets: ReadonlyMap<string, Sheet | null>;
  /** The metrics that read this source. */
  metrics: readonly MetricView[];
  compact: boolean;
  now: number;
  sync?: SyncState;
  actions: SourcePageActions;
  /** A push source's keys, drawn by the caller (they come from the control plane). */
  keys?: ReactNode;
  /** Where rows are sent (`sheetRowsEndpoint`). */
  endpoint: string;
  onOpen: (path: string) => void;
}) {
  const colors = useColors();
  const status = sourceStatus(source, sheets, now, sync);
  const every = textOf(source.about?.properties.every);
  const statusText =
    source.kind === "context"
      ? "Built in · counted as you read · nothing to connect"
      : source.kind === "push"
        ? `${status.text} · send from your code`
        : source.kind === "fetch"
          ? `${status.text} · every hour · read-only`
          : source.kind === "usage"
            ? `${status.text} · every hour · owners only`
          : [status.text, every === "" ? (source.kind === "cloudflare" || source.kind === "stripe" || source.kind === "github" ? "every hour" : "") : `every ${every}`, "read-only"].filter((part) => part !== "").join(" · ");
  const files: FileLine[] = [
    {
      name: "about.md",
      path: source.about === null ? null : source.aboutPath,
      sheet: false,
      kind: ABOUT_LINE[source.kind] ?? "Settings for this source, shown below",
      last: source.about?.updatedAt === undefined ? "" : `Edited ${ago(source.about.updatedAt, now)}`,
    },
    ...source.datasets.map((dataset) => {
      const sheet = sheets.get(dataset.path) ?? null;
      return {
        name: `${dataset.name}.csv`,
        path: dataset.computed ? null : dataset.path,
        sheet: true,
        columns: columnsWords(sheet),
        rows: sheet === null ? "" : rowsWords(sheet.rows.length),
        last: dataset.computed ? "Counted now" : lastRowWords(lastRowAt(sheet), now),
      };
    }),
  ];
  const buttons = (
    <>
      {actions.syncNow === undefined ? null : (
        <DataButton label="Sync now" leading={<RefreshGlyph size={12} color={colors.text} />} onPress={actions.syncNow} compact={compact} />
      )}
      {actions.reconnect === undefined ? null : (
        <DataButton label="Connect again" leading={<RefreshGlyph size={12} color={colors.text} />} onPress={actions.reconnect} compact={compact} />
      )}
      {actions.disconnect === undefined ? null : <DataButton label="Disconnect" onPress={actions.disconnect} compact={compact} />}
      {actions.repositories === undefined ? null : <DataButton label="Repositories…" onPress={actions.repositories} compact={compact} />}
      {actions.newKey === undefined ? null : <DataButton label="New key" leading={<PlusGlyph size={12} color={colors.text} />} onPress={actions.newKey} compact={compact} />}
      {actions.more === undefined ? null : (
        <DataButton label="More" square leading={<MoreGlyph size={14} color={colors.text} />} onPress={actions.more} compact={compact} />
      )}
    </>
  );
  const hasButtons = actions.syncNow !== undefined || actions.reconnect !== undefined || actions.disconnect !== undefined || actions.repositories !== undefined || actions.newKey !== undefined || actions.more !== undefined;
  const lede = source.about?.lede?.trim() || LEDE[source.kind] || null;
  const openAbout = source.about === null ? null : <SectionLink label="Open about.md" onPress={() => onOpen(source.aboutPath)} />;
  const firstSheet = source.datasets[0] === undefined ? null : (sheets.get(source.datasets[0].path) ?? null);
  const call = sendRowCall(endpoint, firstSheet);
  return (
    <View testID="data-source-page">
      <PageHead
        tile={<SourceMark kind={source.kind} size={compact ? 32 : 36} />}
        title={source.slug}
        status={{ tone: status.tone, text: statusText }}
        actions={hasButtons ? buttons : null}
        lede={lede}
        compact={compact}
      />
      {/* Said of a synced source's sheets (07); a push or built-in source's lede already says what its sheets are (09, 10). */}
      <SectionHead title="Files" right={compact || source.kind === "push" || source.kind === "context" ? null : `${files.length} files · ordinary files you can open, copy or download`} compact={compact} />
      <FileRows files={files} compact={compact} onOpen={onOpen} />
      {source.kind === "push" ? (
        <>
          {keys === undefined ? null : (
            <>
              <SectionHead title="Keys" right={compact ? null : "A key is shown once, when it is made. Only its name stays here."} compact={compact} />
              {keys}
            </>
          )}
          <SectionHead title="Send rows" right={compact ? null : "A row without a date gets today's"} compact={compact} />
          <CodeBlock lines={call.lines} {...(actions.copy === undefined ? {} : { onCopy: () => actions.copy?.(call.text) })} />
        </>
      ) : null}
      {source.kind === "context" ? <ContextCounts source={source} sheets={sheets} compact={compact} openAbout={openAbout} /> : null}
      {source.kind === "fetch" ? <UrlSync source={source} status={status.text} sync={sync} now={now} compact={compact} openAbout={openAbout} /> : null}
      {source.kind === "usage" ? <UsageSync status={status.text} sync={sync} now={now} compact={compact} openAbout={openAbout} /> : null}
      {metrics.length === 0 && source.kind === "context" ? null : (
        <>
          <SectionHead title="Metrics that read these" compact={compact} />
          {metrics.length === 0 ? (
            <Words text="No metric reads this source yet." quiet />
          ) : (
            <MetricRows metrics={metrics} compact={compact} onOpen={onOpen} />
          )}
        </>
      )}
      {source.kind === "push" || source.kind === "context" || source.kind === "fetch" || source.kind === "usage" ? null : (
        <>
          <SectionHead title="Settings" right={openAbout} compact={compact} />
          <SettingsGrid settings={settingsOf(source, sync === undefined ? undefined : urlSyncLine(status.text, sync, now).replace("Press Sync now to run it.", "An owner connects it from Connect a source."))} compact={compact} />
        </>
      )}
    </View>
  );
}

/**
 * A url source's address, its dataset and how its last run went, as its about.md and its sync object say: the
 * run's own sentence when it failed or stopped, never anything the address answered.
 */
export function urlSyncLine(status: string, sync: SyncState | undefined, now: number): string {
  if (sync?.said !== undefined && (sync.stopped === true || (sync.failedAt !== undefined && (sync.syncedAt === undefined || sync.failedAt >= sync.syncedAt)))) return sync.said;
  if (sync?.syncedAt !== undefined) return [`Synced ${ago(sync.syncedAt, now)}`, sync.rows === undefined ? "" : rowsWords(sync.rows)].filter((part) => part !== "").join(" · ");
  return sync?.known === true ? "Not synced yet. Press Sync now to run it." : status;
}

function UrlSync({ source, status, sync, now, compact, openAbout }: { source: DataSource; status: string; sync: SyncState | undefined; now: number; compact: boolean; openAbout: ReactNode }) {
  const url = textOf(source.about?.properties.url);
  const dataset = textOf(source.about?.properties.dataset);
  const key = textOf(source.about?.properties.key);
  const date = textOf(source.about?.properties.date);
  return (
    <>
      <SectionHead title="Sync" right={openAbout} compact={compact} />
      <PropsGrid
        compact={compact}
        rows={[
          { key: "address", value: url === "" ? <Words text="No address yet: add url: to about.md" quiet /> : <Code text={url} long /> },
          { key: "dataset", value: dataset === "" ? <Words text="No dataset yet: add dataset: to about.md" quiet /> : <Code text={`${dataset}.csv`} /> },
          ...(key === "" ? [] : [{ key: "key", value: <Code text={key} /> }]),
          ...(date === "" ? [] : [{ key: "date", value: <Code text={date} /> }]),
          { key: "every", value: <Words text="hour" /> },
          { key: "last sync", value: <Words text={urlSyncLine(status, sync, now)} quiet={sync?.syncedAt === undefined && sync?.failedAt === undefined} /> },
        ]}
      />
    </>
  );
}

/** The usage source's sync: its five sheets, every hour, and its last run in the url source's words. */
function UsageSync({ status, sync, now, compact, openAbout }: { status: string; sync: SyncState | undefined; now: number; compact: boolean; openAbout: ReactNode }) {
  return (
    <>
      <SectionHead title="Sync" right={openAbout} compact={compact} />
      <PropsGrid
        compact={compact}
        rows={[
          { key: "reads", value: <Words text="All of Context: who texted, wrote or called each day, and every bug report people sent, by an id that names no one" /> },
          { key: "sheets", value: <>{USAGE_SHEETS.map((name) => <Code key={name} text={`${name}.csv`} />)}</> },
          { key: "who sees it", value: <Words text="Owners only. A sheet anyone else can open stops the sync." /> },
          { key: "every", value: <Words text="hour" /> },
          { key: "last sync", value: <Words text={urlSyncLine(status, sync, now)} quiet={sync?.syncedAt === undefined && sync?.failedAt === undefined} /> },
        ]}
      />
    </>
  );
}

function ContextCounts({ source, sheets, compact, openAbout }: { source: DataSource; sheets: ReadonlyMap<string, Sheet | null>; compact: boolean; openAbout: ReactNode }) {
  const counted = countedFolders(source);
  const folders = (list: readonly string[], words: string) =>
    list.length === 0 ? (
      <Words text="No folders yet: name them in about.md" quiet />
    ) : (
      <>
        {list.map((folder) => (
          <Code key={folder} text={`${folder}/`} />
        ))}
        <Words text={words} small />
      </>
    );
  const every = textOf(source.about?.properties.every) || null;
  const byStatus = source.datasets.find((d) => d.name === "notes-by-status");
  const sheet = byStatus === undefined ? null : (sheets.get(byStatus.path) ?? null);
  const latest = (sheet?.rows ?? []).slice(-4);
  return (
    <>
      <SectionHead title="What it counts" right={openAbout} compact={compact} />
      <PropsGrid
        compact={compact}
        rows={[
          { key: "notes by status", value: folders(counted.byStatus, "by each note's status line") },
          { key: "time to answered", value: folders(counted.answered, "from asked to answered") },
          ...(every === null ? [] : [{ key: "every", value: <Words text={every} /> }]),
        ]}
      />
      {latest.length === 0 ? null : (
        <>
          <SectionHead title="Latest rows in notes-by-status.csv" compact={compact} />
          <MiniTable
            columns={[
              { name: "date", numeric: false },
              { name: "folder", numeric: false },
              { name: "status", numeric: false },
              { name: "notes", numeric: true },
            ]}
            rows={latest.map((row) => [monthDay(Date.parse(row.date ?? "")), row.folder ?? "", row.status ?? "", row.notes ?? ""])}
          />
        </>
      )}
    </>
  );
}

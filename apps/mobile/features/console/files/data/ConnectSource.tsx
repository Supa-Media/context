/**
 * Connect a source (board 02): the board's **Apps**, for an owner, each connected once: GitHub by installing
 * Context's read-only GitHub App (`GithubConnect.tsx`, boards 02b and 02c, on the web only), Stripe and Cloudflare
 * with a read-only key; and its "Your own" ways, **Send from your code** and **Fetch from a URL**.
 *
 * - An app's form takes the key (and, for a Cloudflare token reaching several accounts, the account ID), makes the
 *   app's folder (`about.md` saying `source: stripe` or `source: cloudflare`, and its empty sheet) unless one is there, and
 *   hands the key to the gateway, which checks it with the app and keeps it sealed. It is never written to a file.
 *
 * - Send from your code makes the source's folder in the data folder (`about.md` saying `source: push`, and one
 *   dataset sheet with the columns named here), then the sheet's own key flow makes a key, shown once.
 * - Fetch from a URL makes the folder (`about.md` saying `source: url` with the address and the dataset, and the
 *   dataset's empty sheet), then the caller arms the sync, which runs it at once, and opens the source's page.
 *
 * Each way's form is the same small language: the way's own row on top, two or three fields, a line saying what
 * is made, and the dialog's own buttons.
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { pointerType, radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Shell } from "../DialogShell";
import { APP_DATASETS, appSourceFiles, pushSourceFiles, urlSourceFiles, type AppSourceFiles, type ConnectApp, type PushSourceFiles, type UrlSourceFiles } from "./dataWrites";
import { ChevronGlyph, LockGlyph, SourceMark } from "./Marks";
import type { DataSource } from "./sources";
import { GithubForm, GithubRepos, type GithubFlow } from "./GithubConnect";

type Way = "push" | "url" | ConnectApp | "github" | "github-repos";

const APP_TILES: Readonly<Record<ConnectApp, { title: string; line: string }>> = {
  stripe: { title: "Stripe", line: "Revenue" },
  cloudflare: { title: "Cloudflare", line: "AI spend" },
};

const APP_FORMS: Readonly<Record<ConnectApp, { line: string; field: string; placeholder: string; hint: string }>> = {
  stripe: {
    line: "A restricted key that reads your balance. Context only reads, every hour, and never shows the key again.",
    field: "Restricted key",
    placeholder: "rk_live_…",
    hint: "In Stripe: Developers → API keys → Create restricted key, with Balance transactions: Read and nothing else. A secret key (sk_) is refused.",
  },
  cloudflare: {
    line: "An API token that reads analytics. Context only reads, every hour, and never shows the token again.",
    field: "API token",
    placeholder: "Paste the token",
    hint: "In Cloudflare: My Profile → API Tokens → Create Token, with Account Analytics: Read and nothing else.",
  },
};

const WAYS: Readonly<Record<"push" | "url", { title: string; line: string; kind: "push" | "fetch" }>> = {
  push: { title: "Send from your code", line: "A key and one web request. You name the columns; rows land in a new dataset.", kind: "push" },
  url: { title: "Fetch from a URL", line: "Context reads JSON or CSV from an address every hour, into a dataset.", kind: "fetch" },
};

export function ConnectSourceDialog({
  dataFolder,
  taken,
  sheet,
  onMake,
  onMakeUrl,
  onConnectApp,
  sources,
  start,
  github,
  onClose,
}: {
  dataFolder: string;
  /** Every path under the data folder now, so a new source never lands on one. */
  taken: ReadonlySet<string>;
  /** A phone's sheet on the bottom of the glass. */
  sheet: boolean;
  /** Write the push source's two files; resolves to null once written, or to why not. */
  onMake: (files: PushSourceFiles) => Promise<string | null>;
  /** Write the url source's two files and arm its sync; absent where it can't be armed, and the way is not offered. */
  onMakeUrl?: (files: UrlSourceFiles) => Promise<string | null>;
  /** An owner's Connect of an app with its key; absent for anyone else, and the Apps are not drawn. */
  onConnectApp?: (files: AppSourceFiles) => Promise<string | null>;
  /** The workspace's sources now, so an app already connected says so and is connected again in place. */
  sources?: readonly DataSource[];
  /** Open straight on one app's form: a source page's Connect again, or GitHub's Repositories…. */
  start?: ConnectApp | "github" | "github-repos";
  /** An owner's GitHub install, on the web: absent elsewhere, and its tile is not drawn. */
  github?: GithubFlow;
  onClose: () => void;
}) {
  const [way, setWay] = useState<Way | null>(start ?? (onMakeUrl === undefined && onConnectApp === undefined ? "push" : null));
  // Set once GitHub connected in this dialog: its first sync is still running, and the picker says so.
  const [firstRun, setFirstRun] = useState(false);
  const existing = (app: ConnectApp | "github") => sources?.find((source) => source.kind === app) ?? null;
  if ((way === "github" || way === "github-repos") && github !== undefined) {
    return (
      <Shell title="GitHub" onClose={onClose} sheet={sheet} closable>
        {way === "github" ? (
          <GithubForm
            flow={github}
            onConnected={() => {
              setFirstRun(true);
              setWay("github-repos");
            }}
            onClose={onClose}
          />
        ) : (
          <GithubRepos flow={github} firstRun={firstRun} onClose={onClose} />
        )}
      </Shell>
    );
  }
  return (
    <Shell title="Connect a source" onClose={onClose} sheet={sheet} closable={way === null}>
      {way === null || way === "github" || way === "github-repos" ? (
        <Choose onPick={setWay} apps={onConnectApp !== undefined} github={github !== undefined} url={onMakeUrl !== undefined} connected={(app) => existing(app) !== null} />
      ) : way === "push" ? (
        <PushForm dataFolder={dataFolder} taken={taken} onMake={onMake} onClose={onClose} />
      ) : way === "url" ? (
        <UrlForm dataFolder={dataFolder} taken={taken} onMake={onMakeUrl!} onClose={onClose} />
      ) : (
        <AppForm app={way as ConnectApp} dataFolder={dataFolder} taken={taken} existing={existing(way as ConnectApp)} onMake={onConnectApp!} onClose={onClose} />
      )}
    </Shell>
  );
}

/** Board 02: the Apps an owner connects, then the "Your own" rows, each opening its form. */
function Choose({ onPick, apps, github, url, connected }: { onPick: (way: Way) => void; apps: boolean; github: boolean; url: boolean; connected: (app: ConnectApp | "github") => boolean }) {
  const styles = useThemedStyles(connectStyles);
  const colors = useColors();
  const own: Way[] = url ? ["push", "url"] : ["push"];
  return (
    <>
      <Text style={styles.lede}>Connected once for the whole workspace. Every area and metric can use it.</Text>
      {apps ? (
        <>
          <Text style={styles.section}>APPS</Text>
          <View style={styles.tiles}>
            {github ? <AppTile app="github" connected={connected("github")} onPress={() => onPick("github")} /> : null}
            {(Object.keys(APP_TILES) as ConnectApp[]).map((app) => (
              <AppTile key={app} app={app} connected={connected(app)} onPress={() => onPick(app)} />
            ))}
          </View>
        </>
      ) : null}
      <Text style={styles.section}>YOUR OWN</Text>
      <View style={styles.ways}>
        {own.map((each, index) => (
          <WayRow key={each} way={each as "push" | "url"} ruled={index > 0} onPress={() => onPick(each)} />
        ))}
      </View>
      {apps ? (
        <View style={styles.owners}>
          <LockGlyph size={12} color={colors.muted} />
          <Text style={styles.ownersText}>Only workspace owners can connect apps. You're an owner here.</Text>
        </View>
      ) : null}
    </>
  );
}

const GITHUB_TILE = { title: "GitHub", line: "Pull requests, deploys, workflow runs" };

function AppTile({ app, connected, onPress }: { app: ConnectApp | "github"; connected: boolean; onPress: () => void }) {
  const tile = app === "github" ? GITHUB_TILE : APP_TILES[app];
  const styles = useThemedStyles(connectStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${tile.title}${connected ? ", connected" : ""}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.tile, hovered && { backgroundColor: colors.chipFill }]}
      testID={`connect-app-${app}`}
    >
      <View style={styles.tileTop}>
        <SourceMark kind={app} size={28} />
        {connected ? <Text style={styles.badge}>Connected</Text> : null}
      </View>
      <Text style={styles.wayTitle}>{tile.title}</Text>
      <Text style={styles.wayLine}>{tile.line}</Text>
    </Pressable>
  );
}

function WayRow({ way, ruled, onPress }: { way: "push" | "url"; ruled: boolean; onPress: () => void }) {
  const styles = useThemedStyles(connectStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={WAYS[way].title}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.wayRow, ruled && styles.wayRowRule, hovered && { backgroundColor: colors.chipFill }]}
      testID={`connect-way-${way}`}
    >
      <SourceMark kind={WAYS[way].kind} size={28} />
      <View style={styles.wayText}>
        <Text style={styles.wayTitle}>{WAYS[way].title}</Text>
        <Text style={styles.wayLine}>{WAYS[way].line}</Text>
      </View>
      <ChevronGlyph size={14} color={colors.muted} />
    </Pressable>
  );
}

/** The chosen way's row, over its form. */
function WayHead({ way, line }: { way: "push" | "url" | ConnectApp; line: string }) {
  const styles = useThemedStyles(connectStyles);
  const app = way !== "push" && way !== "url";
  return (
    <View style={styles.way} testID={app ? `connect-${way}` : way === "push" ? "connect-push" : "connect-url"}>
      <SourceMark kind={app ? way : WAYS[way].kind} size={28} />
      <View style={styles.wayText}>
        <Text style={styles.wayTitle}>{app ? APP_TILES[way].title : WAYS[way].title}</Text>
        <Text style={styles.wayLine}>{line}</Text>
      </View>
    </View>
  );
}

/** The foot every form ends with: what is made, Cancel, and the way's button. */
export function Foot({ lands, busy, ready, onMake, onClose, testID, label = "Make source", busyLabel = "Making…" }: { lands: string; busy: boolean; ready: boolean; onMake: () => void; onClose: () => void; testID: string; label?: string; busyLabel?: string }) {
  const styles = useThemedStyles(connectStyles);
  const colors = useColors();
  return (
    <>
      <Text style={[styles.lands, { color: colors.muted }]}>{lands}</Text>
      <View style={styles.foot}>
        <Button label="Cancel" variant="dialog" onPress={onClose} />
        <Button label={busy ? busyLabel : label} variant="dialogPrimary" disabled={!ready} onPress={onMake} testID={testID} />
      </View>
    </>
  );
}

export function Problem({ text }: { text: string | null }): ReactNode {
  return text === null ? null : (
    <Text variant="error" testID="connect-problem">
      {text}
    </Text>
  );
}

/** Make the files, then hand them on; `busy` and the problem line, as each form shows them. */
function useMaking<T>(onMake: (files: T) => Promise<string | null>) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const make = async (files: T | string) => {
    if (typeof files === "string") {
      setProblem(files);
      return;
    }
    setBusy(true);
    setProblem(null);
    const why = await onMake(files).catch(() => "That did not work. Try again.");
    setBusy(false);
    if (why !== null) setProblem(why);
  };
  return { busy, problem, make };
}

function PushForm({ dataFolder, taken, onMake, onClose }: { dataFolder: string; taken: ReadonlySet<string>; onMake: (files: PushSourceFiles) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [dataset, setDataset] = useState("");
  const [columns, setColumns] = useState("");
  const { busy, problem, make } = useMaking(onMake);
  const ready = name.trim() !== "" && dataset.trim() !== "" && !busy;
  return (
    <>
      <WayHead way="push" line="A key lets a script or CI job add rows to one sheet. It can only add rows." />
      <TextField label="Name" value={name} onChangeText={setName} placeholder="Such as Eval CI" testID="connect-name" />
      <TextField label="Dataset" value={dataset} onChangeText={setDataset} placeholder="Such as bench-runs" testID="connect-dataset" />
      <TextField
        label="Columns"
        value={columns}
        onChangeText={setColumns}
        placeholder="suite, p95 ms:number, errors:number"
        hint="Separated by commas; add :number or :date after a name to type it. A date column is added when there is none."
        testID="connect-columns"
      />
      <Problem text={problem} />
      <Foot
        lands={`Makes a folder in ${dataFolder}/ with an about.md and the sheet. You make its key next.`}
        busy={busy}
        ready={ready}
        onMake={() => ready && void make(pushSourceFiles(dataFolder, name, dataset, columns, taken))}
        onClose={onClose}
        testID="connect-make"
      />
    </>
  );
}

function UrlForm({ dataFolder, taken, onMake, onClose }: { dataFolder: string; taken: ReadonlySet<string>; onMake: (files: UrlSourceFiles) => Promise<string | null>; onClose: () => void }) {
  const [address, setAddress] = useState("");
  const [dataset, setDataset] = useState("");
  const { busy, problem, make } = useMaking(onMake);
  const ready = address.trim() !== "" && dataset.trim() !== "" && !busy;
  return (
    <>
      <WayHead way="url" line="Context reads the address every hour and keeps what it answers. It sends no key and no sign-in." />
      <TextField
        label="Address"
        value={address}
        onChangeText={setAddress}
        placeholder="https://status.example.com/incidents.json"
        hint="https on a public name. JSON that is a list of rows, or a CSV sheet."
        testID="connect-url-address"
      />
      <TextField label="Dataset" value={dataset} onChangeText={setDataset} placeholder="Such as open-incidents" testID="connect-url-dataset" />
      <Problem text={problem} />
      <Foot
        lands={`Makes a folder in ${dataFolder}/ with an about.md and the sheet, and syncs it now.`}
        busy={busy}
        ready={ready}
        onMake={() => ready && void make(urlSourceFiles(dataFolder, address, dataset, taken))}
        onClose={onClose}
        testID="connect-url-make"
      />
    </>
  );
}

function AppForm({
  app,
  dataFolder,
  taken,
  existing,
  onMake,
  onClose,
}: {
  app: ConnectApp;
  dataFolder: string;
  taken: ReadonlySet<string>;
  existing: DataSource | null;
  onMake: (files: AppSourceFiles) => Promise<string | null>;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [account, setAccount] = useState("");
  const { busy, problem, make } = useMaking(onMake);
  const ready = key.trim() !== "" && !busy;
  const form = APP_FORMS[app];
  const lands =
    existing === null
      ? `Makes ${dataFolder}/${app}/ with an about.md and ${APP_DATASETS[app]}.csv, and syncs it now. The ${app === "stripe" ? "key" : "token"} is kept sealed, never in a file.`
      : `Connects ${existing.folder}/ again with this ${app === "stripe" ? "key" : "token"}, in place of the one it had, and syncs it now.`;
  return (
    <>
      <WayHead way={app} line={form.line} />
      <TextField
        label={form.field}
        value={key}
        onChangeText={setKey}
        placeholder={form.placeholder}
        hint={form.hint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        testID="connect-app-key"
      />
      {app === "cloudflare" ? (
        <TextField
          label="Account ID"
          optional
          value={account}
          onChangeText={setAccount}
          placeholder="Only when the token reaches several accounts"
          autoCapitalize="none"
          autoCorrect={false}
          testID="connect-app-account"
        />
      ) : null}
      <Problem text={problem} />
      <Foot
        lands={lands}
        busy={busy}
        ready={ready}
        label="Connect"
        busyLabel="Connecting…"
        onMake={() => ready && void make(appSourceFiles(dataFolder, app, { key, account }, existing, taken))}
        onClose={onClose}
        testID="connect-app-make"
      />
    </>
  );
}

export const connectStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, marginTop: -6 },
    section: { fontSize: pointerType.label, lineHeight: 14, fontWeight: "600", letterSpacing: 0.5, color: colors.muted },
    ways: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.cardSurface, overflow: "hidden" },
    wayRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 11 },
    wayRowRule: { borderTopWidth: 1, borderTopColor: colors.line },
    way: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.cardSurface,
    },
    wayText: { flexGrow: 1, flexShrink: 1 },
    wayTitle: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text },
    wayLine: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    foot: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 10 },
    lands: { fontSize: pointerType.meta, lineHeight: 16 },
    tiles: { flexDirection: "row", gap: 8 },
    tile: {
      flexGrow: 1,
      flexBasis: 0,
      gap: 2,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.cardSurface,
    },
    tileTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 },
    badge: { fontSize: pointerType.label, lineHeight: 14, fontWeight: "600", color: colors.okText, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radii.xs, borderWidth: 1, borderColor: colors.okBorder },
    owners: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line },
    ownersText: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 1 },
  });

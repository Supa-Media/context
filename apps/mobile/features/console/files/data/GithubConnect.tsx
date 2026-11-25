/**
 * GitHub's two steps in Connect a source: board 02b, what it reads and fills before anyone approves it, with
 * Connect GitHub (read-only), which opens GitHub's install page in a window of its own; and board 02c, the
 * repositories to read once it is connected (all of them until the owner picks). The calls and the window are
 * `githubSync.ts`'s; this file only draws and hands on.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { connectStyles, Foot, Problem } from "./ConnectSource";
import { SheetGlyph, SourceMark } from "./Marks";
import { GITHUB_COLUMNS, GITHUB_DATASETS, type GithubRepo } from "./githubSync";

/** What the dialog hands GitHub's steps: each resolves to null once done, or the sentence saying why not. */
export interface GithubFlow {
  /** Make the source's folder and sheets if missing, open GitHub, and finish the install when it sends the owner back. */
  readonly begin: () => Promise<string | null>;
  readonly repos: () => Promise<{ repos: GithubRepo[]; picked: string[] | null } | string>;
  readonly pick: (names: readonly string[]) => Promise<string | null>;
}

/** Board 02b. */
export function GithubForm({ flow, onConnected, onClose }: { flow: GithubFlow; onConnected: () => void; onClose: () => void }) {
  const shared = useThemedStyles(connectStyles);
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const begin = async () => {
    setBusy(true);
    setProblem(null);
    const why = await flow.begin().catch(() => "That did not work. Try again.");
    setBusy(false);
    if (why === null) onConnected();
    else setProblem(why);
  };
  return (
    <>
      <View style={shared.way} testID="connect-github">
        <SourceMark kind="github" size={28} />
        <View style={shared.wayText}>
          <Text style={shared.wayTitle}>GitHub</Text>
          <Text style={shared.wayLine}>Read-only, for the whole workspace</Text>
        </View>
      </View>
      <View style={styles.can}>
        <Text style={styles.canLine}>
          <Text style={{ color: colors.ok }}>✓ </Text>Reads pull requests, deploys and runs
        </Text>
        <Text style={styles.canLine}>
          <Text style={{ color: colors.muted }}>✕ </Text>Can't change code, settings or secrets
        </Text>
      </View>
      <View style={styles.eyebrowRow}>
        <Text style={shared.section}>IT FILLS THREE DATASETS</Text>
        <Text style={styles.eyebrowRight}>in data/github/</Text>
      </View>
      <View style={styles.sets}>
        {GITHUB_DATASETS.map((dataset) => (
          <View key={dataset} style={styles.set} testID={`github-set-${dataset}`}>
            <View style={styles.setTop}>
              <SheetGlyph size={14} color={colors.muted} />
              <Text style={styles.setName}>{dataset}</Text>
              <Text style={styles.setKind}>csv</Text>
            </View>
            <View style={styles.chips}>
              {GITHUB_COLUMNS[dataset].map((column) => (
                <Text key={column} style={styles.chip}>
                  {column.replace("_", " ")}
                </Text>
              ))}
            </View>
          </View>
        ))}
      </View>
      <Problem text={problem} />
      <Foot
        lands={busy ? "Finish on GitHub, in the window that opened. This waits for you." : "GitHub opens in a new window to ask you. The first sync brings in the last 90 days, then it syncs every hour. No AI model runs."}
        busy={busy}
        ready={!busy}
        label="Connect GitHub (read-only)"
        busyLabel="Waiting for GitHub…"
        onMake={() => void begin()}
        onClose={onClose}
        testID="connect-github-make"
      />
    </>
  );
}

/** Board 02c. */
export function GithubRepos({ flow, onClose }: { flow: GithubFlow; onClose: () => void }) {
  const shared = useThemedStyles(connectStyles);
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void flow.repos().then((answer) => {
      if (!live) return;
      if (typeof answer === "string") {
        setProblem(answer);
        setRepos([]);
        return;
      }
      setRepos(answer.repos);
      setPicked(new Set(answer.picked ?? answer.repos.slice(0, 10).map((repo) => repo.name)));
    });
    return () => {
      live = false;
    };
  }, [flow]);
  const toggle = (name: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(name)) next.delete(name);
      else if (next.size < 10) next.add(name);
      return next;
    });
  const start = async () => {
    setBusy(true);
    setProblem(null);
    const why = await flow.pick([...picked]).catch(() => "That did not work. Try again.");
    setBusy(false);
    if (why === null) onClose();
    else setProblem(why);
  };
  return (
    <>
      <View style={styles.connected}>
        <Text style={[styles.connectedText, { color: colors.okText }]}>● Connected</Text>
        <Text style={styles.connectedBy}>· read-only, by you</Text>
      </View>
      <Text style={shared.section}>REPOSITORIES TO READ</Text>
      <View style={styles.repos} testID="github-repos">
        {repos === null ? (
          <Text style={styles.empty}>Asking GitHub…</Text>
        ) : repos.length === 0 ? (
          <Text style={styles.empty}>GitHub gave Context no repositories. Add some to the App's installation on GitHub.</Text>
        ) : (
          repos.map((repo, index) => (
            <Pressable
              key={repo.name}
              role="checkbox"
              aria-checked={picked.has(repo.name)}
              accessibilityLabel={repo.name}
              onPress={() => toggle(repo.name)}
              style={[styles.repo, index > 0 && styles.repoRule]}
              testID={`github-repo-${repo.name}`}
            >
              <View style={[styles.box, picked.has(repo.name) && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                {picked.has(repo.name) ? <Text style={styles.tick}>✓</Text> : null}
              </View>
              <SourceMark kind="github" size={13} />
              <Text style={styles.repoName}>{repo.name}</Text>
              {repo.private ? <Text style={styles.repoKind}>private</Text> : null}
            </Pressable>
          ))
        )}
      </View>
      <Text style={styles.hint}>New repositories are left out until you add them here. At most 10.</Text>
      <Problem text={problem} />
      <Foot lands="Syncs every hour" busy={busy} ready={!busy && picked.size > 0} label="Start syncing" busyLabel="Syncing…" onMake={() => void start()} onClose={onClose} testID="github-repos-start" />
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    can: { gap: 4, paddingHorizontal: 2 },
    canLine: { fontSize: pointerType.meta, lineHeight: 17, color: colors.text },
    eyebrowRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
    eyebrowRight: { fontSize: pointerType.label, lineHeight: 14, color: colors.muted },
    sets: { gap: 6 },
    set: { gap: 6, padding: 10, borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.cardSurface },
    setTop: { flexDirection: "row", alignItems: "center", gap: 6 },
    setName: { fontSize: pointerType.ui, lineHeight: 17, fontWeight: "600", color: colors.text, flexGrow: 1 },
    setKind: { fontSize: pointerType.label, lineHeight: 14, color: colors.muted },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
    chip: { fontSize: pointerType.label, lineHeight: 14, color: colors.text2, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radii.xs, backgroundColor: colors.chipFill },
    connected: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: -6 },
    connectedText: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "600" },
    connectedBy: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    repos: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.cardSurface, overflow: "hidden" },
    repo: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
    repoRule: { borderTopWidth: 1, borderTopColor: colors.line },
    box: { width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
    tick: { fontSize: pointerType.label, lineHeight: 12, color: "#FFFFFF", fontWeight: "700" },
    repoName: { fontSize: pointerType.ui, lineHeight: 17, color: colors.text, flexGrow: 1, flexShrink: 1 },
    repoKind: { fontSize: pointerType.label, lineHeight: 14, color: colors.muted },
    empty: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, padding: 12 },
    hint: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, marginTop: -6 },
  });

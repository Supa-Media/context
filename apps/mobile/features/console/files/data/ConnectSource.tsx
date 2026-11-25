/**
 * Connect a source (board 02), as far as this stage goes: the board's "Your own" ways, **Send from your code** and
 * **Fetch from a URL**. GitHub, Cloudflare and Stripe need an owner's connection and wait for their stage, so the
 * board's app tiles are not drawn until they work.
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
import { pushSourceFiles, urlSourceFiles, type PushSourceFiles, type UrlSourceFiles } from "./dataWrites";
import { ChevronGlyph, SourceMark } from "./Marks";

type Way = "push" | "url";

const WAYS: Readonly<Record<Way, { title: string; line: string; kind: "push" | "fetch" }>> = {
  push: { title: "Send from your code", line: "A key and one web request. You name the columns; rows land in a new dataset.", kind: "push" },
  url: { title: "Fetch from a URL", line: "Context reads JSON or CSV from an address every hour, into a dataset.", kind: "fetch" },
};

export function ConnectSourceDialog({
  dataFolder,
  taken,
  sheet,
  onMake,
  onMakeUrl,
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
  onClose: () => void;
}) {
  const [way, setWay] = useState<Way | null>(onMakeUrl === undefined ? "push" : null);
  return (
    <Shell title="Connect a source" onClose={onClose} sheet={sheet}>
      {way === null ? (
        <Choose onPick={setWay} />
      ) : way === "push" ? (
        <PushForm dataFolder={dataFolder} taken={taken} onMake={onMake} onClose={onClose} />
      ) : (
        <UrlForm dataFolder={dataFolder} taken={taken} onMake={onMakeUrl!} onClose={onClose} />
      )}
    </Shell>
  );
}

/** Board 02's "Your own" rows, each opening its form. */
function Choose({ onPick }: { onPick: (way: Way) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <Text style={styles.lede}>Connected once for the whole workspace. Every area and metric can use it.</Text>
      <Text style={styles.section}>YOUR OWN</Text>
      <View style={styles.ways}>
        {(["push", "url"] as const).map((each, index) => (
          <WayRow key={each} way={each} ruled={index > 0} onPress={() => onPick(each)} />
        ))}
      </View>
    </>
  );
}

function WayRow({ way, ruled, onPress }: { way: Way; ruled: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
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
function WayHead({ way, line }: { way: Way; line: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.way} testID={way === "push" ? "connect-push" : "connect-url"}>
      <SourceMark kind={WAYS[way].kind} size={28} />
      <View style={styles.wayText}>
        <Text style={styles.wayTitle}>{WAYS[way].title}</Text>
        <Text style={styles.wayLine}>{line}</Text>
      </View>
    </View>
  );
}

/** The foot every form ends with: what is made, Cancel, and the way's button. */
function Foot({ lands, busy, ready, onMake, onClose, testID }: { lands: string; busy: boolean; ready: boolean; onMake: () => void; onClose: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <>
      <Text style={[styles.lands, { color: colors.muted }]}>{lands}</Text>
      <View style={styles.foot}>
        <Button label="Cancel" variant="dialog" onPress={onClose} />
        <Button label={busy ? "Making…" : "Make source"} variant="dialogPrimary" disabled={!ready} onPress={onMake} testID={testID} />
      </View>
    </>
  );
}

function Problem({ text }: { text: string | null }): ReactNode {
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

const makeStyles = (colors: Colors) =>
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
  });

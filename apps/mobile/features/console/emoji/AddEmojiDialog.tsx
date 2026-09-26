/**
 * Add a custom emoji: upload a picture, or find one on Slackmojis.
 *
 * Opened from the editor's `:` menu (and then the emoji goes where the `:`
 * was) or from Settings › Emoji. The name starts as what was typed after `:`,
 * or else as the file's or the Slackmojis emoji's own name, because that is
 * the name somebody was already reaching for.
 */

import { useEffect, useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { CUSTOM_EMOJI_MAX_BYTES, CUSTOM_EMOJI_NAME, customEmojiNameFrom } from "@context/shared";

import { Button, PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, pointerType as t, radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { EmojiHostContext, SlackmojiResult } from "../files/emoji/host";
import { standardEmojiNamed } from "../files/emoji/standardEmoji";
import { dataUrlFor } from "../files/imageBytes";
import { pickEmojiFile } from "./pickEmojiFile";

type Outcome = { name: string } | { error: string; code?: string };

/** Why a name cannot be used, or `null` when it can. */
export function nameProblem(name: string, taken: readonly string[], replace: boolean): string | null {
  if (name === "") return "Give it a name.";
  if (!CUSTOM_EMOJI_NAME.test(name)) return "Lowercase letters, numbers, - and _, starting with a letter or number.";
  if (standardEmojiNamed(name) !== undefined) return `:${name}: is already a standard emoji. Pick another name.`;
  if (taken.includes(name) && !replace) return `This workspace already has :${name}:.`;
  return null;
}

export function AddEmojiDialog({
  initialQuery,
  initialTab,
  taken,
  host,
  upload,
  onClose,
}: {
  initialQuery: string;
  initialTab: "upload" | "slackmojis";
  taken: readonly string[];
  host: EmojiHostContext;
  upload: (name: string, bytes: ArrayBuffer, replace: boolean) => Promise<Outcome>;
  onClose: (name: string | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const canSearch = host.searchSlackmojis !== undefined;
  const [tab, setTab] = useState(canSearch ? initialTab : "upload");
  const [name, setName] = useState(customEmojiNameFrom(initialQuery));
  const [nameTouched, setNameTouched] = useState(initialQuery !== "");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [file, setFile] = useState<{ fileName: string; bytes: ArrayBuffer; src: string } | null>(null);

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<readonly SlackmojiResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<SlackmojiResult | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (tab !== "slackmojis" || host.searchSlackmojis === undefined) return;
    const search = host.searchSlackmojis;
    const needle = query.trim();
    if (needle === "") {
      setResults(null);
      return;
    }
    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      search(needle)
        .then((found) => live && setResults(found))
        .catch(() => live && setError("Slackmojis is not answering right now."))
        .finally(() => live && setSearching(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tab, query, host]);

  useEffect(() => {
    const preview = host.previewSlackmoji;
    if (results === null || preview === undefined) return;
    for (const result of results) {
      if (asked.current.has(result.url)) continue;
      asked.current.add(result.url);
      void preview(result.url).then((src) => {
        if (src !== null) setPreviews((current) => ({ ...current, [result.url]: src }));
      });
    }
  }, [results, host]);

  const problem = nameProblem(name, taken, replace);
  const ready = problem === null && !busy && (tab === "upload" ? file !== null : chosen !== null);

  async function choose() {
    setError(null);
    const picked = await pickEmojiFile();
    if (picked === null) return;
    if (picked.bytes.byteLength > CUSTOM_EMOJI_MAX_BYTES) {
      setError(`That picture is over ${CUSTOM_EMOJI_MAX_BYTES / 1_000_000} MB. Emoji are drawn small; try a smaller one.`);
      return;
    }
    setFile({ ...picked, src: dataUrlFor(picked.bytes, contentTypeOf(picked.fileName)) });
    if (!nameTouched) setName(customEmojiNameFrom(picked.fileName));
  }

  function pick(result: SlackmojiResult) {
    setChosen(result);
    if (!nameTouched) setName(customEmojiNameFrom(result.name));
  }

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const outcome: Outcome =
      tab === "upload" && file !== null
        ? await upload(name, file.bytes, replace)
        : chosen !== null && host.importSlackmoji !== undefined
          ? await importAs(host, chosen, name, replace)
          : { error: "Nothing is chosen." };
    setBusy(false);
    if ("name" in outcome) onClose(outcome.name);
    else setError(outcome.error);
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={() => onClose(null)} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={() => onClose(null)}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel="Add a custom emoji">
          <Text variant="paneTitle" role="heading" aria-level={2}>
            Add a custom emoji
          </Text>
          {canSearch ? (
            <View style={styles.tabs} role="tablist">
              {(["upload", "slackmojis"] as const).map((key) => (
                <PressRow
                  key={key}
                  role="tab"
                  selected={tab === key}
                  accessibilityLabel={key === "upload" ? "Upload" : "Search Slackmojis"}
                  onPress={() => setTab(key)}
                  style={[styles.tab, tab === key ? styles.tabOn : null]}
                >
                  <Text variant="mini">{key === "upload" ? "Upload" : "Search Slackmojis"}</Text>
                </PressRow>
              ))}
            </View>
          ) : null}

          {tab === "upload" ? (
            <View style={styles.uploadRow}>
              <View style={styles.drop}>
                {file === null ? null : <Image source={{ uri: file.src }} style={styles.big} resizeMode="contain" />}
                <Button label={file === null ? "Choose a picture…" : "Choose another"} onPress={() => void choose()} variant="dialog" />
              </View>
              <Text variant="hint" style={styles.flex}>
                PNG, JPEG, GIF or WebP, up to {CUSTOM_EMOJI_MAX_BYTES / 1_000_000} MB. GIFs stay animated. Square pictures look best.
              </Text>
            </View>
          ) : (
            <View style={styles.searchBox}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search Slackmojis"
                accessibilityLabel="Search Slackmojis"
                autoFocus
                style={styles.input}
              />
              <ScrollView style={styles.results} contentContainerStyle={styles.grid}>
                {(results ?? []).map((result) => (
                  <PressRow
                    key={result.url}
                    accessibilityLabel={`:${result.name}:`}
                    selected={chosen?.url === result.url}
                    onPress={() => pick(result)}
                    style={[styles.tile, chosen?.url === result.url ? styles.tileOn : null]}
                  >
                    {previews[result.url] === undefined ? (
                      <View style={styles.small} />
                    ) : (
                      <Image source={{ uri: previews[result.url] }} style={styles.small} resizeMode="contain" />
                    )}
                    <Text variant="treeMetaMono" numberOfLines={1} style={styles.tileName}>
                      {result.name}
                    </Text>
                  </PressRow>
                ))}
              </ScrollView>
              <Text variant="hint">
                {searching
                  ? "Searching…"
                  : results !== null && results.length === 0
                    ? "Nothing on Slackmojis by that name."
                    : "From slackmojis.com, fetched by Context. Adding copies it into this workspace."}
              </Text>
            </View>
          )}

          <View style={styles.nameRow}>
            <Text variant="mini">Name</Text>
            <View style={styles.nameField}>
              <Text variant="mono" style={styles.colon}>:</Text>
              <TextInput
                value={name}
                onChangeText={(next) => {
                  setNameTouched(true);
                  setName(next.toLowerCase().replace(/\s+/g, "-"));
                }}
                accessibilityLabel="Emoji name"
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, styles.flex]}
              />
              <Text variant="mono" style={styles.colon}>:</Text>
            </View>
            {taken.includes(name) ? (
              <PressRow
                accessibilityLabel="Replace the existing one"
                role="button"
                ariaChecked={replace}
                onPress={() => setReplace((value) => !value)}
                style={styles.replace}
              >
                <Text variant="hint">{replace ? "☑" : "☐"} Replace the existing :{name}:</Text>
              </PressRow>
            ) : null}
            {problem !== null && name !== "" ? <Text variant="error">{problem}</Text> : null}
          </View>

          {error !== null ? <Text variant="error">{error}</Text> : null}
          <Text variant="hint">Everyone in this workspace can use it.</Text>
          <View style={styles.actions}>
            <Button label="Cancel" onPress={() => onClose(null)} variant="dialog" />
            <Button
              label={busy ? "Adding…" : name === "" ? "Add emoji" : `Add :${name}:`}
              onPress={() => void submit()}
              variant="dialogPrimary"
              disabled={!ready}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A Slackmojis import under exactly the chosen name. */
async function importAs(
  host: EmojiHostContext,
  result: SlackmojiResult,
  name: string,
  replace: boolean,
): Promise<Outcome> {
  const outcome = await host.importSlackmoji?.(result, name, { exact: true, replace });
  return outcome ?? { error: "That emoji could not be added." };
}

function contentTypeOf(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif" || extension === "webp") return `image/${extension}`;
  return "image/png";
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.72)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 560,
      maxHeight: "92%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 22,
      paddingHorizontal: 24,
      gap: 14,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    tabs: { flexDirection: "row", gap: 16, borderBottomWidth: 1, borderColor: colors.lineStrong },
    tab: { paddingVertical: 8, borderBottomWidth: 2, borderColor: "transparent" },
    tabOn: { borderColor: colors.accent },
    uploadRow: { flexDirection: "row", gap: 16, alignItems: "center" },
    drop: {
      width: 160,
      minHeight: 120,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      padding: 12,
    },
    big: { width: 64, height: 64 },
    small: { width: 32, height: 32 },
    flex: { flex: 1 },
    searchBox: { gap: 10 },
    results: { maxHeight: 260 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
    tile: { width: 76, alignItems: "center", gap: 4, paddingVertical: 8, borderRadius: radii.lg },
    tileOn: { backgroundColor: colors.rowSelected, borderWidth: 1, borderColor: colors.accent },
    tileName: { maxWidth: 70 },
    input: {
      fontFamily: fonts.mono,
      fontSize: t.ui,
      color: colors.text,
      paddingVertical: 9,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    nameRow: { gap: 6 },
    nameField: { flexDirection: "row", alignItems: "center", gap: 4 },
    colon: { color: colors.muted },
    replace: { alignSelf: "flex-start", paddingVertical: 4 },
    actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  });

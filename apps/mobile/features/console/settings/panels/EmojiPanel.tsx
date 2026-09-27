/**
 * Settings › Emoji: this workspace's own emoji, with Add, Rename and Remove.
 *
 * Reads and changes them through the console's `CustomEmojiProvider`, the
 * same one the editor's `:` menu uses, so adding one here and adding one from
 * a note are the same act. Absent a provider (the landing page's demo) the
 * panel says there is nothing to show rather than drawing an empty list.
 */

import { useEffect, useState } from "react";
import { Image, StyleSheet, TextInput, View } from "react-native";
import { CUSTOM_EMOJI_NAME } from "@context/shared";

import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { fonts, pointerType as t, radii } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useCustomEmoji, type CustomEmojiValue } from "../../emoji/context";
import { PanelHead } from "./PanelHead";

export function EmojiPanel({ sectioned }: { sectioned: boolean }) {
  const emoji = useCustomEmoji();
  const styles = useThemedStyles(makeStyles);
  const [problem, setProblem] = useState<string | null>(null);
  const names = emoji?.names ?? null;
  return (
    <>
      <PanelHead section="emoji" sectioned={sectioned}>
        Emoji everyone in this workspace can use by typing : and a name in a note. Each one is a picture
        kept in the workspace, so it goes wherever your notes go.
      </PanelHead>
      <Card style={styles.card}>
        {emoji === null ? (
          <Text variant="hint">No workspace is open.</Text>
        ) : (
          <>
            <View style={styles.head}>
              <Text variant="rowSub" style={styles.flex}>
                {names === null ? "Reading…" : names.length === 1 ? "1 custom emoji" : `${names.length} custom emoji`}
              </Text>
              {emoji.openAdd === undefined ? null : (
                <Button
                  label="Add emoji"
                  variant="dialogPrimary"
                  onPress={() => void emoji.openAdd?.({ query: "", tab: "upload" })}
                />
              )}
            </View>
            {(names ?? []).map((name) => (
              <EmojiRow
                key={name}
                name={name}
                emoji={emoji}
                onProblem={setProblem}
              />
            ))}
            {problem !== null ? <Text variant="error">{problem}</Text> : null}
            <Text variant="hint">
              {emoji.canEdit
                ? "Removing one never edits a note: anywhere it was used shows its name as text again."
                : "Editors and owners add, rename and remove emoji."}
            </Text>
          </>
        )}
      </Card>
    </>
  );
}

function EmojiRow({
  name,
  emoji,
  onProblem,
}: {
  name: string;
  emoji: CustomEmojiValue;
  onProblem: (problem: string | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [src, setSrc] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void emoji.load(name).then((next) => live && setSrc(next));
    return () => {
      live = false;
    };
  }, [emoji, name]);

  async function run(work: () => Promise<string | null>) {
    setBusy(true);
    onProblem(null);
    const failure = await work();
    setBusy(false);
    if (failure !== null) onProblem(failure);
    else setRenaming(null);
  }

  return (
    <View style={styles.row}>
      {src === null ? (
        <View style={styles.picture} />
      ) : (
        <Image source={{ uri: src }} style={styles.picture} resizeMode="contain" accessibilityLabel={`:${name}:`} />
      )}
      {renaming === null ? (
        <Text variant="mono" style={styles.flex}>
          :{name}:
        </Text>
      ) : (
        <TextInput
          value={renaming}
          onChangeText={(next) => setRenaming(next.toLowerCase())}
          accessibilityLabel={`New name for ${name}`}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={[styles.input, styles.flex]}
        />
      )}
      {!emoji.canEdit ? null : renaming === null ? (
        <>
          <Button label="Rename" variant="dialog" disabled={busy} onPress={() => setRenaming(name)} />
          <Button label="Remove" variant="dialogDanger" disabled={busy} onPress={() => void run(() => emoji.remove(name))} />
        </>
      ) : (
        <>
          <Button label="Cancel" variant="dialog" onPress={() => setRenaming(null)} />
          <Button
            label="Save"
            variant="dialogPrimary"
            disabled={busy || renaming === name || !CUSTOM_EMOJI_NAME.test(renaming)}
            onPress={() => void run(() => emoji.rename(name, renaming))}
          />
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: 10 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    picture: { width: 28, height: 28 },
    flex: { flex: 1 },
    input: {
      fontFamily: fonts.mono,
      fontSize: t.ui,
      color: colors.text,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
  });

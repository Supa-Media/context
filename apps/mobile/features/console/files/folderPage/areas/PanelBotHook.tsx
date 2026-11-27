/**
 * How Context reaches a bot, in the Setup section of its own page (Dev,
 * 2026-11-27: "the setup options should be in the bot page"; `BotSetup.tsx`):
 * the bot's webhook, the only way it is reached
 * (`apps/convex/functions/botHooks.ts`, decided by the owner 2026-11-25). A bot sets its own from its setup prompt, sending its secret
 * from its shell; by hand, the address and an optional header are typed here
 * once and sealed on the account server, and nobody reads them back. The
 * signing key is made here and sealed with them, and shown once only for a
 * webhook with no header, the one way such a bot can tell a call is ours. After
 * that the panel shows the host, the header's last four characters, who set
 * it, how the last call went, and Send a test.
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";
import { makeSigningKey } from "@context/shared/src/botHooks.cjs";
import { writeClipboard } from "../../../../design/clipboard";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";

/** One saved webhook as the list answers it: never the address or a secret. */
export interface HookRow {
  bot: string;
  host: string;
  headerEnds: string | null;
  setByName: string;
  lastCallAt: number | null;
  lastCallOk: boolean | null;
  lastCallStatus: number | null;
  canReplace: boolean;
}

/** The webhook, as drawn: what is saved and its last call, or the form to save one. */
export function BotHookView({
  bot,
  row,
  canEdit,
  save,
  test,
  extra,
}: {
  bot: string;
  row: HookRow | null | undefined;
  canEdit: boolean;
  save: (address: string, headerLine: string, signingKey: string) => Promise<void>;
  test: () => Promise<{ ok: boolean; status: number }>;
  /** More buttons beside Send a test and Replace (its setup prompt's Copy). */
  extra?: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [header, setHeader] = useState("");
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<string | null>(null);

  if (row === undefined) return null;
  // The bot sets its own webhook from its setup prompt; typing one here is the way by hand, behind a link (the owner, 2026-11-25).
  const showForm = canEdit && editing && (row === null || row.canReplace);

  const onSave = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const key = makeSigningKey((bytes) => globalThis.crypto.getRandomValues(bytes));
    try {
      await save(address.trim(), header.trim(), key);
      // A webhook with a header already proves the call is ours: its key is kept, unseen, and never offered.
      setShownKey(header.trim() === "" ? key : null);
      setCopied(false);
      setEditing(false);
      setAddress("");
      setHeader("");
    } catch (error) {
      const said = (error as { data?: { message?: unknown } })?.data?.message;
      setProblem(typeof said === "string" ? said : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    if (busy) return;
    setBusy(true);
    setTested(null);
    try {
      const answer = await test();
      setTested(answer.ok ? `${bot} answered (${answer.status}).` : answer.status === 0 ? `${bot} couldn't be reached.` : `${bot} answered ${answer.status}.`);
    } catch {
      setTested("The test didn't send. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.box} testID="area-panel-hook">
      {row === null ? null : (
        <View style={styles.saved}>
          <View style={styles.value}>
            <Text variant="tree" numberOfLines={1} testID="area-panel-hook-saved">{`Webhook at ${row.host}`}</Text>
            <Text variant="treeMeta" style={styles.muted} numberOfLines={1} testID="area-panel-hook-detail">
              {[row.headerEnds === null ? "No header" : `Header ends ${row.headerEnds}`, row.setByName === "" ? "" : `set by @${row.setByName}`].filter(Boolean).join(" · ")}
            </Text>
          </View>
          {canEdit ? (
            <View style={styles.actions}>
              <Pressable role="button" onPress={() => void onTest()} style={styles.button} testID="area-panel-hook-test">
                <Text variant="treeMeta" style={styles.linkWord}>Send a test</Text>
              </Pressable>
              {row.canReplace && !editing ? (
                <Pressable role="button" onPress={() => setEditing(true)} style={styles.button} testID="area-panel-hook-replace">
                  <Text variant="treeMeta" style={styles.linkWord}>Replace</Text>
                </Pressable>
              ) : null}
              {extra}
            </View>
          ) : null}
          {tested === null ? null : <Text variant="treeMeta" style={styles.muted} testID="area-panel-hook-last">{tested}</Text>}
        </View>
      )}
      {row === null && !canEdit ? <Text variant="treeMeta" style={styles.muted}>No webhook yet.</Text> : null}
      {row === null && canEdit && !editing ? (
        <View style={styles.saved}>
          <Pressable role="button" onPress={() => setEditing(true)} style={styles.link} testID="area-panel-hook-by-hand">
            <Text variant="treeMeta" style={styles.mutedLink}>Set the webhook up by hand</Text>
          </Pressable>
        </View>
      ) : null}
      {showForm ? (
        <View style={styles.form}>
          <TextInput
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={`${bot}'s webhook address`}
            placeholder="https://… the bot's webhook"
            placeholderTextColor={colors.muted}
            style={[styles.input, fieldFont]}
            testID="area-panel-hook-address"
          />
          <TextInput
            value={header}
            onChangeText={setHeader}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="A header to send, optional"
            placeholder="Authorization: Bearer … (optional)"
            placeholderTextColor={colors.muted}
            style={[styles.input, fieldFont]}
            testID="area-panel-hook-header"
          />
          <Text variant="treeMeta" style={styles.muted}>Saved sealed. Nobody can read it back, you included.</Text>
          <Pressable role="button" onPress={() => void onSave()} disabled={busy || address.trim() === ""} style={[styles.save, address.trim() === "" && styles.off]} testID="area-panel-hook-save">
            <Text variant="treeMeta" style={styles.saveWord}>{row === null ? "Save webhook" : "Replace webhook"}</Text>
          </Pressable>
        </View>
      ) : null}
      {problem === null ? null : <Text variant="treeMeta" role="alert" style={styles.problem}>{problem}</Text>}
      {shownKey === null ? null : (
        <View style={styles.key} testID="area-panel-hook-key">
          <Text variant="treeMeta" style={styles.strong}>Signing key, shown once</Text>
          <Text variant="treeMeta" style={styles.mono} selectable numberOfLines={1}>{shownKey}</Text>
          <Text variant="treeMeta" style={styles.muted}>{`Give it to ${bot} to check each call's x-context-signature.`}</Text>
          <Pressable
            role="button"
            onPress={() => {
              void writeClipboard(shownKey).then(() => setCopied(true));
            }}
            style={styles.link}
            testID="area-panel-hook-key-copy"
          >
            <Text variant="treeMeta" style={styles.linkWord}>{copied ? "Copied" : "Copy key"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** The webhook of one bot in one workspace, read and saved through the account server. */
export function BotHookFields({ workspaceId, bot, canEdit, extra }: { workspaceId: string; bot: string; canEdit: boolean; extra?: React.ReactNode }) {
  const id = workspaceId as Id<"workspaces">;
  const rows = useQuery(api.functions.botHooks.botHookList, { workspaceId: id });
  const setHook = useAction(api.functions.botHooks.setBotHook);
  const testHook = useAction(api.functions.botHooks.testBotHook);
  const name = mailJoinName(bot);
  const row = rows === undefined ? undefined : (rows.find((entry) => entry.bot === name) ?? null);
  return (
    <BotHookView
      bot={bot}
      row={row}
      canEdit={canEdit}
      save={async (address, headerLine, signingKey) => {
        await setHook({ workspaceId: id, bot, address, signingKey, ...(headerLine === "" ? {} : { headerLine }) });
      }}
      test={() => testHook({ workspaceId: id, bot })}
      extra={extra}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { gap: space.x1 },
    saved: { gap: space.x2 },
    value: { gap: 2 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    button: { paddingVertical: 3, paddingHorizontal: space.x3, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    link: { paddingVertical: 2 },
    linkWord: { color: colors.text, fontWeight: "600" },
    form: { gap: space.x1 },
    input: { fontFamily: fonts.body, color: colors.text, paddingVertical: 4, paddingHorizontal: 8, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    save: { alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    off: { opacity: 0.5 },
    saveWord: { color: colors.surface, fontWeight: "600" },
    key: { gap: 2, paddingVertical: space.x1, borderTopWidth: 1, borderTopColor: colors.line },
    strong: { color: colors.text, fontWeight: "600" },
    mono: { fontFamily: fonts.mono, color: colors.text },
    muted: { color: colors.muted },
    mutedLink: { color: colors.muted, textDecorationLine: "underline" },
    problem: { color: colors.critText },
  });

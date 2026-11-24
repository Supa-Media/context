/**
 * "Data sources" on a sheet: a key that lets anything that can send an HTTP
 * request add rows to this one sheet, with no model in between (decided by
 * the owner, 2026-11-24). A CI job posts its timing; the sheet gains a row.
 *
 * The key is shown once, when it is made, with the one call that uses it.
 * After that only its name, how many rows it added and when it was last used
 * are shown, and any editor can revoke it. See
 * `docs/decisions/app-and-console/sheet-sources.md`.
 *
 * Offered only inside the console, to an owner or editor of a live workspace:
 * the button is absent elsewhere, not disabled.
 */

import { useEffect, useState, type JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { writeClipboard } from "../../../design/clipboard";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { edgeOrigin } from "../../../site/edgeAddress";
import { PLATFORM_ORIGIN } from "../../../site/host";
import { useOptionalConsoleData } from "../../ConsoleDataContext";
import { selectedContext } from "../../types";

/** Where rows are sent: this page's own origin when the router serves it, else the platform's. */
export function sheetRowsEndpoint(origin: string | null = edgeOrigin()): string {
  return `${origin ?? PLATFORM_ORIGIN}/api/sheets/rows`;
}

/** The one call a key is used with, ready to paste. The key goes in a header, never the URL. */
export function sourceCurl(endpoint: string, key: string, columns: readonly string[]): string {
  const row = Object.fromEntries(columns.filter((name) => name.toLowerCase() !== "date").map((name) => [name, "…"]));
  return [
    `curl -X POST ${endpoint} \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify({ rows: [row] })}'`,
  ].join("\n");
}

/** "Data sources", for an owner or editor in the console; nothing anywhere else. */
export function SheetSourcesButton({ path, columns }: { path: string; columns: readonly string[] }): JSX.Element | null {
  const data = useOptionalConsoleData();
  const [open, setOpen] = useState(false);
  const current = data === null ? null : selectedContext(data);
  if (data === null || data.demo === true || current === null || (current.role !== "owner" && current.role !== "editor")) return null;
  return (
    <>
      <Button label="Data sources" variant="mini" onPress={() => setOpen(true)} testID="sheet-sources-open" />
      {open ? <SheetSourcesDialog workspaceId={current.id as Id<"workspaces">} path={path} columns={columns} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

interface DocumentLike {
  addEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
  removeEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
}

function used(source: { rowsAdded: number; lastUsedAt: number | null }): string {
  const rows = `${source.rowsAdded} ${source.rowsAdded === 1 ? "row" : "rows"} added`;
  return source.lastUsedAt === null ? `${rows} · not used yet` : `${rows} · last ${new Date(source.lastUsedAt).toLocaleString()}`;
}

function problemOf(error: unknown): string {
  const data = (error as { data?: { message?: string } } | null)?.data;
  return typeof data?.message === "string" ? data.message : "That did not work. Try again.";
}

function SheetSourcesDialog({
  workspaceId,
  path,
  columns,
  onClose,
}: {
  workspaceId: Id<"workspaces">;
  path: string;
  columns: readonly string[];
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const sources = useQuery(api.functions.sheetSources.list, { workspaceId, path });
  const create = useAction(api.functions.sheetSources.create);
  const revoke = useMutation(api.functions.sheetSources.revoke);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState<"key" | "call" | null>(null);

  useEffect(() => {
    const doc = (globalThis as unknown as { document?: DocumentLike }).document;
    if (doc === undefined) return;
    const onKey = (event: { key: string }) => {
      if (event.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mint = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await create({ workspaceId, path, name });
      setMade({ name: name.trim(), key: answer.key });
      setName("");
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = (what: "key" | "call", text: string) => {
    void writeClipboard(text).then((ok) => setCopied(ok ? what : null));
  };

  const call = made === null ? null : sourceCurl(sheetRowsEndpoint(), made.key, columns);

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel="Data sources" testID="sheet-sources-dialog">
          <View style={styles.titleRow}>
            <Text variant="paneTitle" role="heading" aria-level={2}>
              Data sources
            </Text>
            <Pressable role="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8}>
              <Icon name="close" size={14} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
            <Text variant="meta" style={styles.muted}>
              A key lets a script, a CI job or any service add rows to this sheet. It can only add rows here: it cannot read the sheet or touch anything else, and it stops if you leave or stop being an editor.
            </Text>

            {made === null || call === null ? null : (
              <View style={styles.made} testID="sheet-source-made">
                <Text variant="rowTitle">{`Key for ${made.name}`}</Text>
                <Text variant="meta" style={styles.muted}>
                  Copy it now: it is shown once and never again.
                </Text>
                <Text variant="mono" selectable style={styles.code} testID="sheet-source-key">
                  {made.key}
                </Text>
                <Button label={copied === "key" ? "Copied" : "Copy key"} variant="mini" onPress={() => copy("key", made.key)} testID="sheet-source-copy-key" />
                <Text variant="meta" style={styles.muted}>
                  Send rows with one call. A date column fills with today when a row leaves it out.
                </Text>
                <Text variant="mono" selectable style={styles.code} testID="sheet-source-call">
                  {call}
                </Text>
                <Button label={copied === "call" ? "Copied" : "Copy call"} variant="mini" onPress={() => copy("call", call)} testID="sheet-source-copy-call" />
              </View>
            )}

            <View style={styles.block}>
              <Text variant="rowTitle">New key</Text>
              <TextField
                label="Name"
                value={name}
                onChangeText={setName}
                placeholder="Such as GitHub speed budgets"
                testID="sheet-source-name"
              />
              {problem === null ? null : (
                <Text variant="error" testID="sheet-source-problem">
                  {problem}
                </Text>
              )}
              <View style={styles.actions}>
                <Button label={busy ? "Making…" : "Make a key"} variant="dialogPrimary" disabled={busy || name.trim() === ""} onPress={() => void mint()} testID="sheet-source-create" />
              </View>
            </View>

            <View style={styles.block}>
              <Text variant="rowTitle">Keys in use</Text>
              {sources === undefined ? (
                <Text variant="meta" style={styles.muted}>Loading…</Text>
              ) : sources.length === 0 ? (
                <Text variant="meta" style={styles.muted}>None yet.</Text>
              ) : (
                sources.map((source) => (
                  <View key={source.sourceId} style={styles.row} testID="sheet-source-row">
                    <View style={styles.grow}>
                      <Text variant="body" numberOfLines={1}>{source.name}</Text>
                      <Text variant="meta" style={styles.muted}>{used(source)}</Text>
                    </View>
                    <Button
                      label="Revoke"
                      variant="danger"
                      onPress={() => void revoke({ sourceId: source.sourceId }).catch((error: unknown) => setProblem(problemOf(error)))}
                      testID="sheet-source-revoke"
                    />
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: "rgba(3,3,4,.72)", alignItems: "center", justifyContent: "center", padding: 24 },
    card: {
      width: "100%",
      maxWidth: 480,
      maxHeight: "90%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 20,
      paddingHorizontal: 20,
      gap: space.x3,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    scroll: { flexGrow: 0 },
    body: { gap: space.x4 },
    block: { gap: space.x2 },
    made: { gap: space.x2, padding: space.x3, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
    code: { padding: space.x2, borderRadius: radii.sm, backgroundColor: colors.surface },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    grow: { flex: 1, minWidth: 0 },
    actions: { flexDirection: "row", justifyContent: "flex-end" },
    muted: { color: colors.muted },
  });

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { pointerType as t, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { SetupRow, SetupView, ToolRow } from "./rules";

export interface SetupActions {
  onOpenStorage: () => void;
  onOpenTools: () => void;
  /** Copies the bootstrap prompt; resolves true when the clipboard took it. */
  onCopyBootstrap: () => Promise<boolean>;
  onPutAway: () => void;
}

/**
 * W-07 — the setup widget, floating bottom-right over the workspace.
 *
 * Four rows and their facts (`rules.ts`), a header that collapses it to one
 * line, the tools row that opens into its clients and the bootstrap prompt,
 * and the canvas's exit line at the foot. It sits over the note rather than in
 * the page so a person can read and write around it; collapsed, it is one line
 * high.
 */
export function SetupWidget({
  slug,
  view,
  actions,
}: {
  slug: string;
  view: SetupView;
  actions: SetupActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <View style={styles.card} testID="setup-widget">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Set up @${slug}, ${view.done} of ${view.total} done`}
        onPress={() => setOpen((value) => !value)}
        style={styles.head}
        testID="setup-widget-toggle"
      >
        <Text style={styles.headTitle}>Set up @{slug}</Text>
        <Text style={styles.headCount} testID="setup-widget-count">
          {view.done} of {view.total} {open ? "⌃" : "⌄"}
        </Text>
      </Pressable>

      {open ? (
        <>
          {view.rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              action={actionFor(row, actions, toolsOpen, () => setToolsOpen((value) => !value))}
            />
          ))}
          {toolsOpen ? (
            <ToolSubRows tools={view.tools} actions={actions} />
          ) : null}
          <View style={styles.foot}>
            <TextLink
              label="Take everything with you →"
              onPress={actions.onOpenStorage}
              style={styles.footLink}
              testID="setup-widget-exit"
            />
            <TextLink
              label="Hide"
              onPress={actions.onPutAway}
              style={styles.footLink}
              accessibilityLabel="Hide the setup checklist"
              testID="setup-widget-hide"
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

function actionFor(
  row: SetupRow,
  actions: SetupActions,
  toolsOpen: boolean,
  toggleTools: () => void,
): { label: string; onPress?: () => void } {
  switch (row.key) {
    case "handle":
      return { label: "Done" };
    case "storage":
      return { label: row.state === "done" ? "Open →" : "Set up →", onPress: actions.onOpenStorage };
    case "notes":
      return { label: row.state === "done" ? "Done" : "" };
    case "tools":
      return { label: toolsOpen ? "Open ⌃" : "Open ⌄", onPress: toggleTools };
  }
}

function Row({ row, action }: { row: SetupRow; action: { label: string; onPress?: () => void } }) {
  const styles = useThemedStyles(makeStyles);
  const body = (
    <>
      <Text
        style={[styles.mark, row.state === "done" ? styles.markDone : styles.markOpen]}
        aria-hidden
      >
        {row.state === "done" ? "✓" : row.state === "current" ? "●" : "○"}
      </Text>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{row.title}</Text>
        <Text style={styles.rowSub}>{row.sub}</Text>
      </View>
      {action.label ? (
        <Text style={action.onPress ? styles.actionOn : styles.actionOff}>{action.label}</Text>
      ) : null}
    </>
  );
  const style = [styles.row, row.state === "current" && styles.rowCurrent];
  if (action.onPress === undefined) {
    return (
      <View style={style} testID={`setup-row-${row.key}`}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}: ${row.sub}. ${action.label}`}
      onPress={action.onPress}
      style={style}
      testID={`setup-row-${row.key}`}
    >
      {body}
    </Pressable>
  );
}

function ToolSubRows({ tools, actions }: { tools: ToolRow[]; actions: SetupActions }) {
  const styles = useThemedStyles(makeStyles);
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <View style={styles.sub} testID="setup-tools">
      {tools.map((tool) => (
        <Pressable
          key={tool.key}
          accessibilityRole="button"
          accessibilityLabel={`${tool.name}: ${tool.sub}`}
          onPress={tool.status === "verified" ? undefined : actions.onOpenTools}
          style={styles.subRow}
          testID={`setup-tool-${tool.key}`}
        >
          <Text
            style={[styles.subMark, tool.status === "verified" ? styles.markDone : styles.markOpen]}
            aria-hidden
          >
            {tool.status === "verified" ? "✓" : tool.status === "waiting" ? "●" : "○"}
          </Text>
          <View style={styles.rowText}>
            <Text style={styles.subTitle}>{tool.name}</Text>
            <Text style={styles.subSub}>{tool.sub}</Text>
          </View>
          <Text style={tool.status === "verified" ? styles.subActionOff : styles.subActionOn}>
            {tool.status === "verified"
              ? "Verified"
              : tool.status === "waiting"
                ? "Continue →"
                : "Set up →"}
          </Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy the bootstrap prompt"
        onPress={() => {
          void actions.onCopyBootstrap().then(setCopied);
        }}
        style={styles.subRow}
        testID="setup-tool-bootstrap"
      >
        <Text style={[styles.subMark, styles.markOpen]} aria-hidden>
          ○
        </Text>
        <View style={styles.rowText}>
          <Text style={styles.subTitle}>Bootstrap context</Text>
          <Text style={styles.subSub} role={copied === null ? undefined : "status"}>
            {copied === true
              ? "Copied — paste it into Claude or ChatGPT"
              : copied === false
                ? "Could not copy — open AI apps in Settings"
                : "Fill it from what your AI already knows"}
          </Text>
        </View>
        <Text style={styles.subActionOn}>Try it →</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      width: 340,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.ground,
      overflow: "hidden",
      boxShadow: "0 8px 24px rgba(26,23,20,.10)",
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
      paddingHorizontal: 14,
      backgroundColor: colors.surface2,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    headTitle: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    headCount: { fontSize: t.meta, color: colors.text2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 13,
      paddingHorizontal: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    rowCurrent: { backgroundColor: colors.hintWash },
    mark: { width: 22, textAlign: "center", fontSize: t.ui, fontWeight: "700" },
    markDone: { color: colors.okText },
    markOpen: { color: colors.accent },
    rowText: { flex: 1, minWidth: 0, gap: 1 },
    rowTitle: { fontSize: t.ui, fontWeight: "500", color: colors.text },
    rowSub: { fontSize: t.meta, color: colors.text2 },
    actionOn: { fontSize: t.meta, fontWeight: "600", color: colors.accent },
    actionOff: { fontSize: t.meta, fontWeight: "500", color: colors.muted },
    sub: {
      paddingTop: space.x1,
      paddingBottom: space.x3,
      paddingLeft: 44,
      paddingRight: 14,
      backgroundColor: colors.surface3,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    subRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
    subMark: { width: 16, textAlign: "center", fontSize: t.meta, fontWeight: "700" },
    subTitle: { fontSize: t.meta, fontWeight: "500", color: colors.text },
    subSub: { fontSize: t.label, color: colors.text2 },
    subActionOn: { fontSize: t.label, fontWeight: "600", color: colors.accent },
    subActionOff: { fontSize: t.label, fontWeight: "500", color: colors.muted },
    foot: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 14,
      backgroundColor: colors.surface2,
    },
    footLink: { fontSize: t.meta },
  });

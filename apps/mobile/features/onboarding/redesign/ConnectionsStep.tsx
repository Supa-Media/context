import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { TextLink } from "../../design/components/TextLink";
import { CopyField } from "../../design/components/CopyField";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { fonts, leading, radii, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { ENDPOINT_NOTE, INSTALL_COMMAND, INSTALL_NOTE, TIER_NOTE } from "../agents";

/**
 * A-07 — Connections, as an onboarding step.
 *
 * Coding agents get one installer command; the endpoint remains for apps that
 * command cannot reach. Below it, the clients the guides cover — Claude
 * Desktop and ChatGPT — each
 * carry their own status pill and a link into the setup walkthrough. Other
 * MCP-speaking clients are named but not called out; the endpoint works for
 * them the same way, and pretending otherwise would be inventing an integration
 * where there is only a URL.
 */
export type ClientStatus = "not-connected" | "connecting" | "connected" | "grant-pending";

export interface ClientRow {
  key: "claude-desktop" | "chatgpt" | "cursor" | "codex" | "notion-ai";
  name: string;
  status: ClientStatus;
  /** Whether the guide has a dedicated screen. */
  hasGuide: boolean;
}

export function ConnectionsStep({
  clients,
  onOpenGuide,
  onSkip,
}: {
  clients: readonly ClientRow[];
  onOpenGuide: (client: ClientRow["key"]) => void;
  onSkip: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Add Context to one of the AI tools you already use. Each row turns
        green once that tool has signed in and made its first call.
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        In your coding agents
      </Text>
      <CopyField
        value={INSTALL_COMMAND}
        label="Copy the install command"
        testID="welcome-connections-install"
      />
      <Text variant="foot" style={styles.hint}>
        {INSTALL_NOTE}
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        Your MCP endpoint
      </Text>
      <CopyField
        value={MCP_ENDPOINT}
        label="Copy your MCP endpoint"
        testID="welcome-connections-endpoint"
      />
      <Text variant="foot" style={styles.hint}>
        {ENDPOINT_NOTE}
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        Clients we have a guide for
      </Text>
      <View style={styles.list}>
        {clients.map((client) => (
          <ClientTile
            key={client.key}
            client={client}
            onPress={() => onOpenGuide(client.key)}
          />
        ))}
      </View>

      <Text variant="foot" style={styles.hint}>
        {TIER_NOTE}
      </Text>

      <View style={styles.footRow}>
        {clients.some((client) => client.status === "connected") ? (
          <Button label="Continue" variant="accent" onPress={onSkip} testID="welcome-connections-continue" />
        ) : (
          <TextLink label="Skip for now" onPress={onSkip} testID="welcome-connections-continue" />
        )}
        <Text variant="foot" style={styles.footHint}>
          You can come back to this from Settings › Connections.
        </Text>
      </View>
    </View>
  );
}

function ClientTile({
  client,
  onPress,
}: {
  client: ClientRow;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { pill, cta } = statusFor(client.status);
  return (
    <View style={styles.tile}>
      <View style={styles.tileHead}>
        <Text style={styles.tileName}>{client.name}</Text>
        <Pill tone={pill.tone} dashed={pill.dashed}>
          {pill.label}
        </Pill>
      </View>
      {client.hasGuide ? (
        <View style={styles.tileFoot}>
          <Button label={cta} variant="mini" onPress={onPress} />
        </View>
      ) : (
        <Text variant="foot" style={styles.tileNote}>
          MCP-native. Paste the endpoint into its MCP settings.
        </Text>
      )}
    </View>
  );
}

function statusFor(status: ClientStatus): {
  pill: { label: string; tone: "ok" | "warn" | "neutral"; dashed: boolean };
  cta: string;
} {
  switch (status) {
    case "connected":
      return { pill: { label: "Connected", tone: "ok", dashed: false }, cta: "Open guide" };
    case "connecting":
      return { pill: { label: "Waiting", tone: "warn", dashed: true }, cta: "Continue setup" };
    case "grant-pending":
      return { pill: { label: "Grant pending", tone: "warn", dashed: false }, cta: "Approve" };
    case "not-connected":
      return { pill: { label: "Not connected", tone: "neutral", dashed: true }, cta: "Set up" };
  }
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { marginBottom: space.x5, lineHeight: leading(12.5, 1.7), color: colors.text2 },
    code: {
      fontFamily: fonts.mono,
      color: colors.accent,
      fontSize: t.meta,
    },
    head: { marginTop: space.x2, marginBottom: space.x2 },
    hint: { marginTop: space.x2, marginBottom: space.x5, color: colors.muted, lineHeight: leading(12.5, 1.6) },
    list: { gap: space.x2 },
    tile: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4,
    },
    tileHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    tileName: {
      fontFamily: fonts.body,
      fontSize: t.lede,
      fontWeight: "600",
      color: colors.text,
      letterSpacing: tracking(15, -0.01),
    },
    tileFoot: { marginTop: space.x3, flexDirection: "row" },
    tileNote: { marginTop: space.x2, color: colors.muted, lineHeight: leading(12.5, 1.6) },
    footRow: {
      marginTop: space.x6,
      gap: space.x2,
    },
    footHint: { color: colors.muted, lineHeight: leading(12.5, 1.6) },
  });

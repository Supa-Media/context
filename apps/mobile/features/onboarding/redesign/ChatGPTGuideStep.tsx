import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { CopyField } from "../../design/components/CopyField";
import { Text } from "../../design/components/Text";
import { fonts, leading, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { CLAUDE_CUSTOM_INSTRUCTION } from "../agents";
import { InstructionBlock } from "./ClaudeGuideStep";

/**
 * A-10 — ChatGPT setup walkthrough.
 *
 * ChatGPT's MCP surface lives under the Connectors pane on plans that support
 * custom connectors; on Free the person will not have it, so the copy names
 * that outright rather than sending them looking. Same three-thing shape as
 * Claude's guide: turn on the surface, add the endpoint, paste the standing
 * instruction (into Custom Instructions here, because that is what carries).
 */
export function ChatGPTGuideStep({
  onDone,
  onBack,
}: {
  onDone: () => void;
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        ChatGPT's MCP support lives under Connectors on Plus, Pro, and Team.
        Free plans cannot add a custom connector today — if that is you, the
        Claude Desktop path is the shorter road.
      </Text>

      <Step
        number={1}
        title="Open Connectors"
        body="ChatGPT → Settings → Connectors. Look for Developer connectors (or “Add custom connector”). On a Free plan this pane is absent."
      />
      <Step
        number={2}
        title="Add Context as a custom connector"
        body="Name: Context. Endpoint: paste the URL below. Enable it for the models you use — GPT-4o and o1 are what most people connect."
        after={
          <CopyField
            value={MCP_ENDPOINT}
            label="Copy your MCP endpoint"
            testID="welcome-chatgpt-endpoint"
          />
        }
      />
      <Step
        number={3}
        title="Allow it to run tools"
        body="On the first conversation ChatGPT will confirm the connector can act. Pick Always allow so it does not ask every turn."
      />
      <Step
        number={4}
        title="Paste the standing instruction"
        body="Settings → Personalization → Custom instructions → the “How would you like ChatGPT to respond?” box. Paste the block below."
        after={<InstructionBlock value={CLAUDE_CUSTOM_INSTRUCTION} testID="welcome-chatgpt-instruction" />}
      />

      <View style={styles.actions}>
        <Button label="Back" variant="ghost" onPress={onBack} />
        <Button label="Done — ChatGPT is set" variant="white" onPress={onDone} />
      </View>
    </View>
  );
}

function Step({
  number,
  title,
  body,
  after,
}: {
  number: number;
  title: string;
  body: string;
  after?: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.step}>
      <View style={styles.stepHead}>
        <View style={styles.stepBullet}>
          <Text style={styles.stepBulletText}>{number}</Text>
        </View>
        <Text style={styles.stepTitle}>{title}</Text>
      </View>
      <Text variant="rowSub" style={styles.stepBody}>
        {body}
      </Text>
      {after && <View style={styles.stepAfter}>{after}</View>}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: {
      marginBottom: space.x5,
      lineHeight: leading(12.5, 1.7),
      color: colors.text2,
    },
    step: {
      borderLeftWidth: 2,
      borderLeftColor: colors.line,
      paddingLeft: space.x4,
      paddingVertical: space.x3,
      marginBottom: space.x3,
    },
    stepHead: { flexDirection: "row", alignItems: "center", gap: space.x3, marginBottom: space.x2 },
    stepBullet: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    stepBulletText: {
      fontFamily: fonts.body,
      color: colors.ground,
      fontWeight: "700",
      fontSize: t.meta,
    },
    stepTitle: {
      fontFamily: fonts.display,
      fontSize: t.lede,
      fontWeight: "600",
      color: colors.text,
      letterSpacing: tracking(15, -0.01),
      flex: 1,
    },
    stepBody: {
      color: colors.text2,
      lineHeight: leading(12.5, 1.65),
      marginLeft: space.x1 * 8 + space.x3,
    },
    stepAfter: {
      marginTop: space.x3,
      marginLeft: space.x1 * 8 + space.x3,
    },
    actions: {
      marginTop: space.x6,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      justifyContent: "space-between",
    },
  });

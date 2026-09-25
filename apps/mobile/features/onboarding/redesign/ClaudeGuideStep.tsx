import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { TextLink } from "../../design/components/TextLink";
import { CopyField } from "../../design/components/CopyField";
import { Text } from "../../design/components/Text";
import { useCopy } from "../../design/useCopy";
import { fonts, leading, radii, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { CLAUDE_CUSTOM_INSTRUCTION } from "../agents";

/**
 * A-08 — Claude Desktop setup walkthrough.
 *
 * We are not (yet) a marketplace listing in Claude Desktop, so the person is
 * doing three things by hand: enabling developer mode, adding a custom MCP,
 * and — the one that turns Context from a lookup tool into a memory —
 * pasting a custom instruction that tells Claude to `orient` and
 * `save_context` on its own. The custom instruction (`CLAUDE_CUSTOM_INSTRUCTION`)
 * lives in `agents.ts` because it is a product claim about client behaviour
 * that every guide screen restates verbatim.
 */

export function ClaudeGuideStep({
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
        Three things in Claude Desktop. Do them once, and every future
        conversation opens already knowing your projects.
      </Text>

      <Step
        number={1}
        title="Enable developer mode"
        body="Claude Desktop → Settings → Developer. Turn on Developer mode. This is what makes the “Add MCP server” button appear."
      />
      <Step
        number={2}
        title="Add Context as an MCP server"
        body="Same Settings pane → MCP servers → Add. Name it Context and paste your endpoint below. Save."
        after={
          <CopyField
            value={MCP_ENDPOINT}
            label="Copy your MCP endpoint"
            testID="welcome-claude-endpoint"
          />
        }
      />
      <Step
        number={3}
        title="Allow it to run tools"
        body="Open any conversation. Claude Desktop asks whether Context may call its tools — pick Always allow so it does not ask every turn."
      />
      <Step
        number={4}
        title="Give it the standing instruction"
        body="Settings → Profile → Personal preferences. Paste the block below. This is what turns a tool call into memory."
        after={<InstructionBlock value={CLAUDE_CUSTOM_INSTRUCTION} testID="welcome-claude-instruction" />}
      />

      <View style={styles.actions}>
        <Button label="Done — Claude is set" variant="accent" onPress={onDone} />
        <TextLink label="Back" onPress={onBack} />
      </View>
    </View>
  );
}

/**
 * A copyable multi-line block, for the custom-instruction paragraphs the
 * two-line `CopyField` cannot hold.
 */
export function InstructionBlock({ value, testID }: { value: string; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { label, copy } = useCopy(value);
  return (
    <View style={styles.block} testID={testID}>
      <Text variant="code" style={styles.blockBody} selectable>
        {value}
      </Text>
      <View style={styles.blockActions}>
        <Button
          label={label === "Copy" ? "Copy" : label}
          variant="mini"
          onPress={copy}
          accessibilityLabel="Copy the custom instruction"
          testID={testID ? `${testID}-copy` : undefined}
        />
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
      gap: 14,
      flexWrap: "wrap",
    },
    block: {
      backgroundColor: colors.well,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: radii.md,
      padding: space.x4,
    },
    blockBody: { lineHeight: leading(12.5, 1.7), color: colors.text },
    blockActions: { marginTop: space.x2, flexDirection: "row" },
  });

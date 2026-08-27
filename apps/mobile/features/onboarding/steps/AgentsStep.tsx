import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { CopyField } from "../../design/components/CopyField";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useCopy } from "../../design/useCopy";
import { colors, leading, radii, space } from "../../design/tokens";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { ENDPOINT_NOTE, KNOWN_CLIENTS, TIER_NOTE } from "../agents";
import type { OnboardingController } from "../useOnboarding";

/**
 * Step 4 — the endpoint, and the prompt that puts something in the bucket.
 *
 * This is the step that decides whether the four before it mattered. They
 * produce a context with folders and no content, and the product's claim is
 * that every tool starts already knowing your projects — which is a promise
 * until something is written. Asking the person to write it is the obvious
 * move and the wrong one; they signed up ninety seconds ago and have nothing
 * to say yet. So the screen hands over an instruction for the clients they
 * already use, and lets those fill the context from what they already know.
 *
 * ## Why the prompt is a copy field and not a button
 *
 * There is no "do it for me" here, and there cannot be: we have no session
 * with their ChatGPT. The honest shape is the one that admits that — a block
 * of text with a copy button, next to the endpoint that has to be pasted
 * somewhere anyway. Dressing it up as an action would be inventing a capability.
 *
 * ## What this screen must not do
 *
 * Claim the endpoint is personal. It is one URL for everybody, and the
 * recurring reaction to seeing it is "is this someone else's?" — so
 * `ENDPOINT_NOTE` answers that where it is asked rather than in a help page.
 * And it must not imply a connected client sees everything: the consent screen
 * defaults every grant to `team`, owners included, and a first-run screen
 * promising otherwise would describe a product we deliberately do not ship.
 * Both sentences live in `../agents.ts` next to the prompt, because all three
 * are claims about what the control plane will actually do.
 */
export function AgentsStep({
  controller,
  onContinue,
}: {
  controller: OnboardingController;
  onContinue: () => void;
}) {
  // The same "Copy" → "Copied" → "Copy" machine `CopyField` uses. The prompt is
  // a block rather than a one-line value, so it cannot be a `CopyField`, but it
  // should behave identically under the thumb.
  const { label: copyLabel, copy } = useCopy(controller.seedPrompt);

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Your context is ready and empty. Paste this endpoint into the tools you already use,
        then give one of them the prompt below — it will fill the context from what it
        already knows about your work.
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        Your MCP endpoint
      </Text>
      <CopyField
        value={MCP_ENDPOINT}
        label="Copy your MCP endpoint"
        testID="welcome-agents-endpoint"
      />
      <Text variant="foot" style={styles.under}>
        {ENDPOINT_NOTE}
      </Text>

      <View style={styles.clients}>
        {KNOWN_CLIENTS.map((client) => (
          <Pill key={client} tone="neutral">
            {client}
          </Pill>
        ))}
      </View>
      <Text variant="foot" style={styles.under}>
        {TIER_NOTE}
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        Then give it this
      </Text>
      <View style={styles.prompt}>
        <Text variant="code" style={styles.promptBody} selectable>
          {controller.seedPrompt}
        </Text>
      </View>
      <View style={styles.promptActions}>
        <Button
          label={copyLabel === "Copy" ? "Copy prompt" : copyLabel}
          variant="ghost"
          onPress={copy}
          accessibilityLabel="Copy the prompt for your AI client"
          testID="welcome-agents-copy"
        />
      </View>

      <View style={styles.actions}>
        <Button
          label="Done"
          variant="white"
          onPress={onContinue}
          testID="welcome-agents-continue"
        />
        {/*
          No "skip". Continuing *is* skipping — nothing on this screen is a
          commitment, and a second button that means the same as the first is
          a decision somebody has to make for no reason.
        */}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { marginBottom: 22, lineHeight: leading(12.5, 1.7) },
  head: { marginTop: 4, marginBottom: 8 },
  under: { marginTop: 8, marginBottom: 18, lineHeight: leading(12.5, 1.6) },
  clients: { flexDirection: "row", flexWrap: "wrap", gap: space.x2, marginTop: 4 },
  prompt: {
    backgroundColor: colors.well,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: space.x4,
  },
  promptBody: { lineHeight: leading(12.5, 1.75) },
  promptActions: { marginTop: 10, flexDirection: "row" },
  actions: { marginTop: 24, flexDirection: "row", alignItems: "center", gap: 14 },
});

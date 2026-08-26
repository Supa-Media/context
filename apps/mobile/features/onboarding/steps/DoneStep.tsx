import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { MCP_ENDPOINT, placeholderIngestionAddress } from "../../console/placeholderData";
import type { OnboardingController } from "../useOnboarding";

/**
 * Step 4 — the two things to take away, and four sentences of orientation.
 *
 * Deliberately short. Somebody thirty seconds into a product does not read a
 * tour, and everything here is discoverable in the console anyway. What they
 * cannot discover is the endpoint — it is the whole point of the product and it
 * is not written down anywhere else — so that goes first, with a copy button.
 */
export function DoneStep({
  controller,
  onOpenConsole,
}: {
  controller: OnboardingController;
  onOpenConsole: () => void;
}) {
  const slug = controller.claimed?.slug ?? "you";
  const skipped = controller.shape.storageSkipped;

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {`@${slug} is yours. Paste this endpoint into Claude, ChatGPT, or any other MCP client and it can read and write your context — under the rules you set.`}
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        Your MCP endpoint
      </Text>
      <CopyField
        value={MCP_ENDPOINT}
        label="Copy your MCP endpoint"
        testID="welcome-endpoint"
      />
      <Text variant="foot" style={styles.under}>
        The same URL for everyone. Your client signs in and gets its own grant, which you can
        revoke on its own at any time.
      </Text>

      <Text variant="eyebrow" style={styles.head}>
        Your capture address
      </Text>
      <CopyField
        value={placeholderIngestionAddress(slug)}
        label="Copy your capture address"
        testID="welcome-capture"
      />
      <Text variant="foot" style={styles.under}>
        Forward anything here and it lands in your context. Only senders you allow can post to
        it — it starts closed, with just your own account email.
      </Text>

      {skipped ? (
        <Notice tone="warn" style={styles.warning}>
          <Text variant="check" role="status" style={styles.warnText}>
            No bucket is connected yet, so there is nowhere to keep notes. The console shows
            this at the top of your context, with the connect form behind it.
          </Text>
        </Notice>
      ) : null}

      <Card style={styles.facts}>
        <Fact
          title="index.md"
          body="The manifest at the root of your bucket — what this context is and how it is arranged. Yours to edit."
        />
        <Fact
          title="privacy.md"
          body="Decides what a connected AI client may see. Context maintains it for you, so changing what is shared is a control in the console rather than a file to hand-edit."
        />
        <Fact
          title="Plain Markdown"
          body="Every note is a plain file in your bucket, readable in Obsidian or anything else, with no export step and no second copy held by us."
        />
        <Fact
          title="Your key, your call"
          body="Revoke the access key at your provider whenever you like. Context loses access immediately and every file stays exactly where it is."
        />
      </Card>

      <View style={styles.actions}>
        <Button
          label="Open your context"
          variant="white"
          onPress={onOpenConsole}
          testID="welcome-done"
        />
      </View>
    </View>
  );
}

function Fact({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.fact}>
      <Text variant="mono" style={styles.factTitle}>
        {title}
      </Text>
      <Text variant="rowSub" style={styles.factBody}>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { marginBottom: 22, lineHeight: leading(12.5, 1.7) },
  head: { marginTop: 4, marginBottom: 8 },
  under: { marginTop: 8, marginBottom: 18, lineHeight: leading(12.5, 1.6) },
  warning: { marginTop: 4, marginBottom: 18 },
  warnText: { color: colors.warnText },
  facts: { gap: 13 },
  fact: { gap: 3 },
  factTitle: { color: colors.codeKey },
  factBody: { lineHeight: leading(12.5, 1.7) },
  actions: { marginTop: 22, flexDirection: "row", alignItems: "center", gap: 14 },
});

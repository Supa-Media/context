import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { MCP_ENDPOINT, placeholderIngestionAddress } from "../../console/placeholderData";
import { storageWarning, stepsFor } from "../flow";
import type { OnboardingController } from "../useOnboarding";

/**
 * Step 4 — the two things to take away, and four sentences of orientation.
 *
 * Deliberately short. Somebody thirty seconds into a product does not read a
 * tour, and everything here is discoverable in the console anyway.
 *
 * The endpoint used to go first, on the reasoning that it is the one thing not
 * written down anywhere else. It now belongs to the tools step, which is about
 * it — but only a run whose bucket connected reaches that step, so this screen
 * still carries it for a run that skipped storage. The lede moves with it:
 * telling somebody to "paste this endpoint" beside no endpoint was the bug that
 * conditional introduced.
 *
 * The one thing this screen has to be careful about is the bucket. It is the
 * last screen of the run, so a context that has nowhere to keep notes has to
 * say so here or not at all — and the person who most needs telling is the one
 * whose bucket check *failed*, which this used to be silent about.
 * `storageWarning` owns that sentence; see `flow.ts`.
 *
 * The capture address is the other thing it has to be careful about, for the
 * same reason and with the opposite failure: this screen told people to
 * forward mail to an address with no receiver behind it, and they did. Whether
 * it may say that is `controller.captureReceivesMail`, which comes from the
 * control plane rather than from this file — see `receivesMail` in
 * `console/ingestion/settings.ts`.
 */
export function DoneStep({
  controller,
  onOpenConsole,
}: {
  controller: OnboardingController;
  onOpenConsole: () => void;
}) {
  const slug = controller.claimed?.slug ?? "you";
  const warning = storageWarning(controller.shape);
  const sawAgentsStep = stepsFor(controller.shape).includes("agents");

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {sawAgentsStep
          ? `@${slug} is yours. Your endpoint is on the previous screen and in the console, under Connections.`
          : `@${slug} is yours. Paste this endpoint into Claude, ChatGPT, or any other MCP client and it can read and write your context — under the rules you set.`}
      </Text>

      {/*
        The endpoint moved to the tools step, which is *about* it — but that
        step only exists on a run whose bucket connected. A run that skipped
        storage lands here having never been shown the one thing the product is
        for, so this screen keeps it in exactly that case. Duplicating it on
        every run would put the same field on two consecutive screens.
      */}
      {sawAgentsStep ? null : (
        <>
          <Text variant="eyebrow" style={styles.head}>
            Your MCP endpoint
          </Text>
          <CopyField
            value={MCP_ENDPOINT}
            label="Copy your MCP endpoint"
            testID="welcome-endpoint"
          />
          <Text variant="foot" style={styles.under}>
            The same URL for everyone. Your client signs in and gets its own grant, which you
            can revoke on its own at any time.
          </Text>
        </>
      )}

      <Text variant="eyebrow" style={styles.head}>
        Your capture address
      </Text>
      {/*
        Copyable only once something is receiving. A copy button thirty seconds
        into a product is an instruction to go and use the address, and until
        the Email Worker ships the only thing that comes back is
        `550 5.1.1 Address does not exist` — which is how this was found. The
        address stays on screen and stays selectable: it is theirs, it is
        reserved, and it is the one that will work. What is withheld is the
        invitation to act on it today.
      */}
      <CopyField
        value={placeholderIngestionAddress(slug)}
        copyable={controller.captureReceivesMail}
        label="Copy your capture address"
        testID="welcome-capture"
      />
      {controller.captureReceivesMail ? (
        <Text variant="foot" style={styles.under}>
          Forward anything here and it lands in your context. Only senders you allow can post
          to it — it starts closed, with just your own account email.
        </Text>
      ) : (
        <Text variant="foot" style={styles.under} testID="welcome-capture-not-receiving">
          This address is reserved for you, but nothing is receiving mail at it yet — anything
          sent to it today bounces.
        </Text>
      )}

      {warning !== null ? (
        <Notice tone="warn" style={styles.warning}>
          <Text variant="check" role="status" style={styles.warnText} testID="welcome-storage-warning">
            {warning}
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

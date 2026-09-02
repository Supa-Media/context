import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { StorageChoice } from "../../console/storage/StorageChoice";
import { connectProgressLabel } from "../../onboarding/verify";
import { storageLede } from "../create";
import type { CreateWorkspaceController } from "../useCreateWorkspace";

/**
 * Step 2 — the workspace's bucket.
 *
 * The connect form is the console's, reused rather than rebuilt, for the reason
 * `../../onboarding/steps/StorageStep` gives: the SSRF host rules, the
 * addressing question, and the copy about what happens to the secret would all
 * rot in a second copy.
 *
 * ## The one thing this says that the onboarding version does not
 *
 * **A storage binding belongs to a `workspaceId`, never a `userId`.** This
 * bucket is not the creator's brain and is not shared with it: a workspace has
 * its own binding, its own credential envelope, and its own audit trail. People
 * arrive at this screen expecting to point the workspace at the bucket they
 * already connected, and it is worth one sentence to say that a separate bucket
 * is the design rather than an oversight — the whole point is that revoking a
 * workspace's credential leaves a personal brain untouched, and vice versa.
 *
 * ## Dropbox leaves the flow, and says so
 *
 * The Dropbox route is a redirect: it takes the browser to Dropbox and returns
 * it to `/connect/dropbox`, not here, so the layout and invitation steps do not
 * happen. `dropboxResumeTo` is deliberately **not** passed — that parameter
 * resumes *onboarding*, and resuming a workspace flow at somebody's personal
 * layout step would be worse than not resuming at all. The note below says
 * where the two skipped steps live instead, before it is pressed rather than
 * after.
 */
export function WorkspaceStorageStep({
  controller,
}: {
  controller: CreateWorkspaceController;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { connectState } = controller;
  const progress = connectProgressLabel(connectState);
  const busy = connectState.kind === "binding" || connectState.kind === "verifying";
  const slug = controller.created?.slug ?? "the workspace";

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {storageLede(slug)}
      </Text>

      {connectState.kind === "connected" ? (
        <Notice tone="ok">
          <Text variant="check" role="status" style={styles.okText}>
            The bucket is connected — we can list it and write to it.
          </Text>
        </Notice>
      ) : (
        <StorageChoice
          workspaceId={controller.created?.workspaceId ?? null}
          connect={controller.connect}
          dropboxNote="Connecting Dropbox leaves this page: you finish on Dropbox and come back to your console, so the layout and invitation steps here are skipped. Both live in the workspace's own settings afterwards. Connecting a bucket keeps you here."
        />
      )}

      {progress ? (
        <Notice style={styles.progress}>
          <View style={styles.progressRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="check" role="status" style={styles.progressBody}>
              {progress}
            </Text>
          </View>
        </Notice>
      ) : null}

      {connectState.kind === "failed" ? (
        <FormError
          headline={connectState.failure.headline}
          next={[connectState.failure.next, connectState.failure.detail]
            .filter(Boolean)
            .join(" ")}
          style={styles.progress}
        />
      ) : null}

      {connectState.kind === "timeout" ? (
        <Notice tone="warn" style={styles.progress}>
          <Text variant="check" role="status" style={styles.warnText}>
            {connectState.message}
          </Text>
        </Notice>
      ) : null}

      <View style={styles.actions}>
        {connectState.kind === "failed" || connectState.kind === "timeout" ? (
          <Button
            label="Carry on anyway"
            accessibilityLabel="Continue without a verified bucket"
            onPress={controller.continuePastStorage}
            testID="workspace-storage-continue"
          />
        ) : null}
        {connectState.kind === "connected" ? null : (
          <Button
            label="I'll do this later"
            variant="ghost"
            disabled={busy}
            onPress={controller.skipStorage}
            testID="workspace-storage-skip"
          />
        )}
      </View>

      {connectState.kind === "connected" ? null : (
        <Text variant="foot" style={styles.later}>
          Skipping is fine and nothing here expires — you can still invite people, and they
          will find the workspace empty until a bucket is connected from its settings.
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  progress: { marginTop: 14 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  progressBody: { flex: 1, minWidth: 0 },
  okText: { color: colors.okText },
  warnText: { color: colors.warnText },
  actions: { marginTop: 16, flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  later: { marginTop: 14, lineHeight: leading(12.5, 1.7) },
});

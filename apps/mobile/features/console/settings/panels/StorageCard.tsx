import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { FieldList, Hint } from "../../../design/components/Field";
import { FormError, Notice } from "../../../design/components/Input";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { leading, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { ConsoleStorage, StorageActions } from "../../types";
import { useArming } from "../../useArming";
import { EncryptionRow } from "../../storage/EncryptionRow";
import { forcePathStyleToAddressing } from "../../storage/connect";
import { describeStorageFailure } from "../../storage/errors";
import { useReverify } from "../../storage/useReverify";
import type { ReverifyState } from "../../storage/reverify";
import { StorageChecks, storageLine, storageVerdict } from "./StorageHealth";

/**
 * Settings › Storage & search: the one card about where this workspace's
 * notes are kept.
 *
 * The approved settings artboard (2026-09-29) draws it in three bands. The
 * verdict first ("Healthy"), with what kind of storage it is, how many files,
 * when it was checked and "Check again". Then the two lines that verdict rests
 * on. Then "Connection details", closed: the provider, the bucket, the
 * endpoint and key, encryption, and the two presses that change the
 * connection (Rotate key, Disconnect). Those answer nothing somebody opening
 * this page is asking; they are there to be copied into a support thread or
 * checked against the provider's console, so they are one press away.
 *
 * Every control comes from `actions`, which is **absent** in the demo console
 * and for anybody who is not an owner: `reverifyStorage`, `bindStorage` and
 * `disconnectStorage` are owner-only, so drawing them for an editor would be
 * offering a button whose only outcome is a permission error.
 */
export function StorageCard({
  storage,
  actions,
  demo,
  onRebind,
}: {
  storage: ConsoleStorage;
  actions: StorageActions | undefined;
  demo: boolean;
  onRebind: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  // The third argument is which context is being verified. A probe's result
  // belongs to one workspace and must never be shown for another — see
  // `useReverify`.
  const reverify = useReverify(
    storage,
    actions ? actions.reverify : null,
    actions ? actions.workspaceId : null,
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const disconnect = useArming(() => {
    if (actions === undefined) return;
    setDisconnecting(true);
    void actions.disconnect().finally(() => setDisconnecting(false));
  });

  const addressing = forcePathStyleToAddressing(storage.forcePathStyle);
  const isDropbox = storage.provider === "dropbox";
  const isManaged = storage.managed === true;

  /**
   * Only the fields this backend actually has.
   *
   * Built by pushing what is present rather than by listing four and letting
   * three of them be `undefined`: a Dropbox binding has no bucket, endpoint,
   * region or access key, and an empty labelled well reads as a field somebody
   * failed to fill in rather than one that does not exist here.
   */
  const fields: Array<{ label: string; value: string }> = [
    {
      label: "Provider",
      value: isManaged ? "Context-managed storage" : isDropbox ? "Dropbox" : storage.provider,
    },
  ];
  // Which account, not just which provider: saying whose Dropbox this is,
  // and noticing a *different* one arriving on a reconnect.
  if (isDropbox && storage.dropboxAccountId) {
    fields.push({ label: "Connected as", value: storage.dropboxAccountId });
  }
  if (storage.bucket) fields.push({ label: "Bucket", value: storage.bucket });
  if (storage.endpoint) fields.push({ label: "Endpoint", value: storage.endpoint });
  if (storage.accessKey) fields.push({ label: "Access key", value: storage.accessKey });
  if (storage.rootPrefix) {
    fields.push({ label: isDropbox ? "Folder" : "Root prefix", value: storage.rootPrefix });
  } else if (isDropbox) {
    fields.push({ label: "Folder", value: "Context's own app folder" });
  }
  // Shown only when somebody actually had to answer it at connect time.
  if (addressing !== null) {
    fields.push({
      label: "Addressing",
      value: addressing === "path" ? "bucket in the path" : "bucket in the hostname",
    });
  }

  const failure =
    storage.status === "error"
      ? describeStorageFailure(storage.errorCode, storage.lastError, storage.provider)
      : null;
  const verdict = storageVerdict(storage, failure !== null);
  const running = reverify.state.kind === "running";

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Dot tone={verdict.tone} size={9} />
        <View style={styles.grow}>
          <Text variant="noteTitle" testID="storage-verdict">
            {verdict.title}
          </Text>
          <Text variant="rowSub" style={styles.line}>
            {storageLine(storage, Date.now())}
          </Text>
        </View>
        {/*
          Available in every status — including `connected`, which is exactly
          when someone checks, because the gateway started failing and a
          credential revoked at the provider still reads `connected` here until
          something asks.
        */}
        {actions === undefined ? null : (
          <Button
            variant="mini"
            label={running ? "Checking…" : "Check again"}
            accessibilityLabel="Check this storage again"
            disabled={reverify.start === null || running}
            onPress={() => reverify.start?.()}
            trailing={running ? <ActivityIndicator color={colors.text} size="small" /> : null}
            testID="storage-reverify"
          />
        )}
      </View>

      <View style={styles.band} testID="storage-capabilities">
        <StorageChecks storage={storage} failed={failure !== null} />
        {/*
          A binding in `error` is the state this page exists to get someone out
          of, so it gets the failure, the fix, and the provider's own words.
        */}
        {failure ? (
          <FormError
            headline={failure.headline}
            next={joinSentences(failure.next, failure.detail)}
            style={styles.notice}
          />
        ) : null}
        <ReverifyStatus state={reverify.state} />
      </View>

      <Pressable
        role="button"
        aria-expanded={showDetails}
        onPress={() => setShowDetails((open) => !open)}
        style={[styles.band, styles.disclosure]}
        testID="storage-details-toggle"
      >
        <Icon name={showDetails ? "chevronUp" : "chevronDown"} size={13} color={colors.accent} />
        <Text variant="rowTitle" style={styles.disclosureText}>
          Connection details
        </Text>
      </Pressable>

      {showDetails ? (
        <View style={styles.details} testID="storage-binding">
          <FieldList fields={fields} testIDPrefix="storage-field" />
          <EncryptionRow storage={storage} />

          {isManaged || actions === undefined ? null : (
            <Row style={styles.actions}>
              {/*
                One button, two honest labels. A Dropbox binding has no key to
                rotate, so offering "Rotate key" against one would name a
                credential that has never existed for it.
              */}
              <Button
                label={isDropbox ? "Reconnect" : "Rotate key"}
                accessibilityLabel={
                  isDropbox
                    ? "Reconnect Dropbox, or connect a bucket instead"
                    : "Paste a new access key and secret"
                }
                disabled={disconnecting}
                onPress={onRebind}
                testID="storage-rebind"
              />
              {/*
                Two presses, and the second expires. What it does is delete the
                binding, and the encrypted secret goes with it: reconnecting
                needs a value R2 or S3 shows exactly once, at creation.
              */}
              <Button
                label={
                  disconnecting
                    ? "Disconnecting…"
                    : disconnect.stage === "armed"
                      ? "Press again to disconnect"
                      : "Disconnect"
                }
                variant="danger"
                disabled={disconnecting}
                onPress={disconnect.press}
                testID="storage-disconnect"
              />
            </Row>
          )}

          {!isManaged && disconnect.stage === "armed" ? (
            <Hint>
              <Text variant="hint">
                Your bucket and every file in it are untouched — Context only forgets how
                to reach them, and you can reconnect by pasting a key. What it cannot give
                back is this secret: it is never sent down from the control plane, so you
                will need the one your provider showed you when you created the key.
              </Text>
            </Hint>
          ) : null}

          {!demo && actions === undefined ? (
            <Text variant="foot" style={styles.readOnly}>
              You have read-only access to this workspace&apos;s storage. Only an owner
              can check, rotate, or disconnect it.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** What Check again is doing, and what came back. */
function ReverifyStatus({ state }: { state: ReverifyState }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  switch (state.kind) {
    case "idle":
      return null;
    case "running":
      return (
        <Notice style={styles.notice}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="check" role="status" style={styles.noticeBody}>
              Checking your bucket — listing it, writing a probe file, and cleaning up after
              itself.
            </Text>
          </View>
        </Notice>
      );
    case "ok":
      return (
        <Notice tone="ok" style={styles.notice}>
          <Text variant="check" role="status" style={styles.okText}>
            {state.message}
          </Text>
        </Notice>
      );
    case "timeout":
      return (
        <Notice tone="warn" style={styles.notice}>
          <Text variant="check" role="status" style={styles.warnText}>
            {state.message}
          </Text>
        </Notice>
      );
    case "failed":
      return (
        <FormError
          headline={state.failure.headline}
          next={joinSentences(state.failure.next, state.failure.detail)}
          style={styles.notice}
        />
      );
  }
}

/** "What to do" then "what the provider said", skipping whichever is missing. */
function joinSentences(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length === 0 ? undefined : kept.join(" ");
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
    },
    head: { flexDirection: "row", alignItems: "center", gap: space.x3, padding: space.x4 },
    grow: { flex: 1, minWidth: 0 },
    line: { marginTop: 1 },
    band: {
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingHorizontal: space.x4,
      paddingVertical: space.x3,
    },
    disclosure: { flexDirection: "row", alignItems: "center", gap: 8 },
    disclosureText: { color: colors.accent },
    details: { paddingHorizontal: space.x4, paddingBottom: space.x4 },
    notice: { marginTop: 12 },
    noticeBody: { flex: 1, minWidth: 0 },
    okText: { color: colors.okText },
    warnText: { color: colors.warnText },
    actions: { marginTop: 17, gap: 9, flexWrap: "wrap" },
    readOnly: { marginTop: 12, lineHeight: leading(12.5, 1.6) },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  });

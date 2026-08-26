import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Dot } from "../../design/components/Dot";
import { Check, FieldGrid } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { useCopy } from "../../design/useCopy";
import { PaneHead } from "../ConsoleShell";
import type { ConsoleData, ConsoleStorage, StorageActions } from "../types";
import { ConnectForm } from "../storage/ConnectForm";
import { forcePathStyleToAddressing } from "../storage/connect";
import { describeStorageFailure } from "../storage/errors";
import { useReverify } from "../storage/useReverify";
import type { ReverifyState } from "../storage/reverify";

/**
 * The customer's bucket, their credentials, and what we could prove about it.
 *
 * Only two of the four capability lines are live today —
 * `getStorageBinding` returns `capabilities.conditionalWrite` and a status.
 * The object count, PARA detection, and versioning state are placeholder and
 * are marked as such in `placeholderData.ts`; they need the connect-time probe
 * to persist what it saw.
 *
 * Every control here comes from `data.storageActions`, which is **absent** in
 * the demo console and for anyone who is not the owner of this context. That is
 * deliberate: `bindStorage`, `reverifyStorage`, and `disconnectStorage` are all
 * owner-only, so rendering them for an editor would be offering a button whose
 * only possible outcome is a permission error.
 */
export function StoragePane({ data }: { data: ConsoleData }) {
  const storage = data.storage;
  const actions = data.storageActions;
  const ingestion = useCopy(data.ingestionAddress);
  const [rebinding, setRebinding] = useState(false);

  return (
    <View>
      <PaneHead
        title="Storage"
        description="Your bucket, your credentials. Revoke the key at your provider and Context loses access immediately — no export needed."
        trailing={storage ? <StatusPill storage={storage} /> : undefined}
      />

      {storage === null ? (
        data.loading ? (
          <Card>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.text2} size="small" />
              <Text variant="rowSub">Loading…</Text>
            </View>
          </Card>
        ) : actions ? (
          <ConnectForm connect={actions.connect} />
        ) : (
          <Card>
            <Text variant="rowTitle">No bucket connected</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              {data.demo
                ? "Context stores nothing of its own. Connect an S3-compatible bucket you own and every note stays in it."
                : "Only an owner of this context can connect a bucket to it."}
            </Text>
          </Card>
        )
      ) : rebinding && actions ? (
        <ConnectForm
          connect={async (values) => {
            const result = await actions.connect(values);
            setRebinding(false);
            return result;
          }}
          // Everything but the credential is prefilled: rotating a key should
          // not mean retyping an endpoint. The secret is never sent back down
          // from the control plane, so it is the one field that starts empty.
          initial={{
            endpoint: storage.endpoint,
            region: storage.region,
            bucket: storage.bucket,
            rootPrefix: storage.rootPrefix ?? "",
            forcePathStyle: storage.forcePathStyle ?? null,
          }}
          onCancel={() => setRebinding(false)}
        />
      ) : (
        <BindingCard
          storage={storage}
          actions={actions}
          demo={data.demo}
          onRebind={() => setRebinding(true)}
        />
      )}

      <Card style={styles.spaced}>
        <Row>
          <Grow>
            <Text variant="rowTitle">Ingestion address</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              Forward any email here and it lands in{" "}
              <Text variant="mono" style={styles.inlineMono}>
                0-inbox/
              </Text>
            </Text>
          </Grow>
          <Button
            label={ingestion.label}
            accessibilityLabel="Copy your ingestion address"
            onPress={ingestion.copy}
          />
        </Row>
        <CopyField value={data.ingestionAddress} copyable={false} style={styles.spacedTight} />
      </Card>
    </View>
  );
}

function StatusPill({ storage }: { storage: ConsoleStorage }) {
  if (storage.connected) {
    return (
      <Pill tone="ok" leading={<Dot tone="ok" />}>
        Connected
      </Pill>
    );
  }
  const broken = storage.status === "error";
  return (
    <Pill tone="warn" leading={<Dot tone={broken ? "crit" : "warn"} />}>
      {broken ? "Not working" : "Not verified"}
    </Pill>
  );
}

function BindingCard({
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
  const reverify = useReverify(storage, actions ? actions.reverify : null);
  const [disconnecting, setDisconnecting] = useState(false);

  const addressing = forcePathStyleToAddressing(storage.forcePathStyle);

  const fields = [
    { label: "Provider", value: storage.provider },
    { label: "Bucket", value: storage.bucket },
    { label: "Endpoint", value: storage.endpoint },
    { label: "Access key", value: storage.accessKey },
  ];
  if (storage.rootPrefix) fields.push({ label: "Root prefix", value: storage.rootPrefix });
  // Shown only when somebody actually had to answer it — the same restraint the
  // connect form applies to asking.
  if (addressing !== null) {
    fields.push({
      label: "Addressing",
      value: addressing === "path" ? "bucket in the path" : "bucket in the hostname",
    });
  }

  const failure =
    storage.status === "error"
      ? describeStorageFailure(storage.errorCode, storage.lastError)
      : null;

  return (
    <Card>
      <FieldGrid fields={fields} />

      <View style={styles.checks}>
        {/*
          The object count is placeholder (see `placeholderData.ts`), but
          reachability is not something to claim in green next to a failure
          panel explaining that the bucket could not be listed. A binding in
          `error` says what it knows, which is nothing.
        */}
        {failure === null ? (
          <Check tone="ok">{`Reachable — ${storage.objectCount} objects`}</Check>
        ) : (
          <Check tone="warn">Last check couldn&apos;t confirm the bucket was usable</Check>
        )}
        {storage.conditionalWrite ? (
          <Check tone="ok">Conditional writes verified — concurrent edits are safe</Check>
        ) : (
          <Check tone="warn">
            Conditional writes unavailable — this provider cannot detect a concurrent edit
          </Check>
        )}
        {storage.paraPresent ? (
          <Check tone="ok">PARA structure present</Check>
        ) : (
          <Check tone="warn">No PARA folders found — Context works either way</Check>
        )}
        {storage.versioningOn ? (
          <Check tone="ok">Versioning is on — point-in-time recovery available</Check>
        ) : (
          <Check tone="warn">
            Versioning is off — turn it on at your provider for point-in-time recovery
          </Check>
        )}
      </View>

      {/*
        A binding in `error` is the state this pane exists to get someone out
        of, so it gets the failure, the fix, and the provider's own words —
        not a one-line `Check` buried among four healthy ones.
      */}
      {failure ? (
        <FormError
          headline={failure.headline}
          next={joinSentences(failure.next, failure.detail)}
          style={styles.failure}
        />
      ) : null}

      <ReverifyStatus state={reverify.state} />

      <Row style={styles.actions}>
        {/*
          Re-verify stays available in every status — including `connected`,
          which is exactly when someone checks, because the gateway started
          failing and a credential revoked at the provider still reads
          `connected` here until something asks.
        */}
        <Button
          label={reverify.state.kind === "running" ? "Checking…" : "Re-verify"}
          accessibilityLabel="Check this bucket again"
          disabled={reverify.start === null || reverify.state.kind === "running"}
          onPress={() => reverify.start?.()}
          trailing={
            reverify.state.kind === "running" ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : null
          }
          testID="storage-reverify"
        />
        <Button
          label="Rotate key"
          accessibilityLabel="Paste a new access key and secret"
          disabled={actions === undefined || disconnecting}
          onPress={onRebind}
          testID="storage-rebind"
        />
        <Button
          label={disconnecting ? "Disconnecting…" : "Disconnect"}
          variant="danger"
          disabled={actions === undefined || disconnecting}
          onPress={() => {
            if (actions === undefined) return;
            setDisconnecting(true);
            void actions.disconnect().finally(() => setDisconnecting(false));
          }}
          testID="storage-disconnect"
        />
      </Row>

      {!demo && actions === undefined ? (
        <Text variant="foot" style={styles.readOnly}>
          You have read-only access to this context&apos;s storage. Only an owner can
          re-verify, rotate, or disconnect it.
        </Text>
      ) : null}
    </Card>
  );
}

/** What Re-verify is doing, and what came back. */
function ReverifyStatus({ state }: { state: ReverifyState }) {
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

const styles = StyleSheet.create({
  rowSub: { marginTop: 2 },
  checks: {
    marginTop: 15,
    gap: 8,
  },
  failure: { marginTop: 15 },
  notice: { marginTop: 15 },
  noticeBody: { flex: 1, minWidth: 0 },
  okText: { color: colors.okText },
  warnText: { color: colors.warnText },
  actions: { marginTop: 17, gap: 9, flexWrap: "wrap" },
  readOnly: { marginTop: 12, lineHeight: leading(12.5, 1.6) },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  spaced: { marginTop: 11 },
  spacedTight: { marginTop: 11 },
  inlineMono: { fontSize: 12 },
});

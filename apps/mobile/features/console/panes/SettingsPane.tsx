import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Check, FieldGrid } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { PaneHead } from "../ConsoleShell";
import { atName } from "../format";
import { loadedFolders } from "../files/browser";
import { IngestionCard } from "../ingestion/IngestionCard";
import { selectedContext, type ConsoleData, type ConsoleStorage, type StorageActions } from "../types";
import { ConnectForm } from "../storage/ConnectForm";
import { forcePathStyleToAddressing } from "../storage/connect";
import { describeStorageFailure } from "../storage/errors";
import { useReverify } from "../storage/useReverify";
import type { ReverifyState } from "../storage/reverify";

/**
 * A context's settings: its bucket, its credentials, and its ingestion rules.
 *
 * This used to be a top-level "Storage" pane sitting beside Map and
 * Connections. It was in the wrong place, and not only visually — a storage
 * binding hangs off a `workspaceId`, never a `userId`, so two contexts can and
 * do point at two different buckets. A pane at app level was quietly claiming
 * there is one. It is reached now from the gear beside the storage chip in
 * Browse, which is where somebody looking at `R2 · brain` is already looking.
 *
 * The components below are the Storage pane's, moved rather than rewritten:
 * the same binding card, the same connect form, the same re-verify state
 * machine.
 *
 * Only two capability lines are live, and only those two are drawn.
 * `getStorageBinding` returns `capabilities.conditionalWrite` and a status;
 * nobody counts the objects in a bucket, looks for its PARA folders, or reads
 * its versioning setting. Those three used to be rendered anyway, from
 * constants, with a green check mark beside them — a bucket holding six
 * objects was told it held 1,284, a bucket with no PARA scaffold was told it
 * had one, and a bucket with versioning already on was told to go and turn it
 * on (#25). They are absent now, and stay absent until the connect-time probe
 * persists what it actually saw.
 *
 * Every control here comes from `data.storageActions`, which is **absent** in
 * the demo console and for anyone who is not the owner of this context. That is
 * deliberate: `bindStorage`, `reverifyStorage`, and `disconnectStorage` are all
 * owner-only, so rendering them for an editor would be offering a button whose
 * only possible outcome is a permission error.
 */
export function SettingsPane({ data, onClose }: { data: ConsoleData; onClose: () => void }) {
  const storage = data.storage;
  const actions = data.storageActions;
  const current = selectedContext(data);
  const hasIngestion = data.ingestion.availability === "available";
  const [rebinding, setRebinding] = useState(false);

  return (
    <View>
      <PaneHead
        title={`${atName(current?.slug ?? "this context")} settings`}
        description="This context's bucket and its ingestion rules. Both belong to the context, not to your account — another context can point somewhere else entirely."
        trailing={
          <View style={styles.headActions}>
            {/*
              Ahead of the storage pill, because it qualifies everything below
              it. Somebody who cannot connect a bucket here, cannot change the
              allow-list here, and cannot see this context's private notes is
              being told all three by one chip and two absent controls.
            */}
            {storage ? <StatusPill storage={storage} /> : null}
            <Button
              label="Done"
              accessibilityLabel="Close settings and go back to browsing"
              onPress={onClose}
              testID="settings-close"
            />
          </View>
        }
      />

      <Text variant="eyebrow" style={styles.sectionHead}>
        Storage
      </Text>
      <Text variant="paneSub" style={styles.sectionSub}>
        Your bucket, your credentials. Revoke the key at your provider and Context loses
        access immediately — no export needed.
      </Text>

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

      {/*
        The blurb describes a setting, so it is shown only where there is one.
        A shared context has no capture address at all, and telling a team to
        forward mail into this context — above a card explaining that they
        cannot — would be the same lie one line higher up. The heading then
        carries the sub's bottom margin, so the card does not ride up against it.
      */}
      <Text
        variant="eyebrow"
        style={[styles.sectionHeadLater, hasIngestion ? null : styles.sectionHeadAlone]}
      >
        Email ingestion
      </Text>
      {hasIngestion ? (
        <Text variant="paneSub" style={styles.sectionSub}>
          Forward mail into this context. The address is semi-public once it is in a
          forwarding rule, so who may send to it is the setting that matters.
        </Text>
      ) : null}

      <IngestionCard
        state={data.ingestion}
        fallbackAddress={data.ingestionAddress}
        folders={loadedFolders(data.files.listings)}
      />
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
  // The third argument is which context is being verified. A probe's result
  // belongs to one workspace and must never be shown for another — see
  // `useReverify`.
  const reverify = useReverify(
    storage,
    actions ? actions.reverify : null,
    actions ? actions.workspaceId : null,
  );
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
          Every line in this block is a claim about somebody's own bucket, so
          each one has to come from something that looked.

          Reachability comes from the binding's status, which the verify probe
          sets by listing the bucket and writing to it. It says "at the last
          check" because that is the only tense it can honestly use: a key
          revoked at the provider a minute ago still reads `connected` here
          until something asks again. An `unverified` binding has never been
          checked at all, so it gets an amber row pointing at Re-verify rather
          than a green one — the status pill above already says "Not verified",
          and a green check disagreeing with it is how a pane loses its
          credibility.

          The object count is rendered only when something counted. Nothing
          does today, so on the live console `storage.objectCount` is undefined
          and the sentence simply ends. See `ConsoleStorage`.
        */}
        {failure !== null ? (
          <Check tone="warn">Last check couldn&apos;t confirm the bucket was usable</Check>
        ) : storage.connected ? (
          <Check tone="ok">
            {storage.objectCount === undefined
              ? "Reachable at the last check"
              : `Reachable at the last check — ${storage.objectCount} objects`}
          </Check>
        ) : (
          <Check tone="warn">
            Not checked since it was connected — Re-verify to confirm it is reachable
          </Check>
        )}
        {storage.conditionalWrite ? (
          <Check tone="ok">Conditional writes verified — concurrent edits are safe</Check>
        ) : (
          <Check tone="warn">
            Conditional writes unavailable — this provider cannot detect a concurrent edit
          </Check>
        )}
        {/*
          PARA detection and versioning state: absent, not "unknown". Nothing
          walks the bucket for PARA folders or reads a versioning setting, and a
          row saying "we don't know whether versioning is on" is noise on a card
          somebody opened to check their credentials. An absent row is quiet;
          the invented ones told a user with versioning already on to go and
          turn it on.
        */}
        {storage.paraPresent === undefined ? null : storage.paraPresent ? (
          <Check tone="ok">PARA structure present</Check>
        ) : (
          <Check tone="warn">No PARA folders found — Context works either way</Check>
        )}
        {storage.versioningOn === undefined ? null : storage.versioningOn ? (
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
  headActions: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  sectionHead: { marginBottom: 4 },
  sectionHeadLater: { marginTop: 30, marginBottom: 4 },
  sectionHeadAlone: { marginBottom: 12 },
  sectionSub: { marginBottom: 12, maxWidth: 546 },
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
});

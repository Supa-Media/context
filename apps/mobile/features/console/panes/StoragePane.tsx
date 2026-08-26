import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Dot } from "../../design/components/Dot";
import { Check, FieldGrid } from "../../design/components/Field";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useCopy } from "../../design/useCopy";
import { PaneHead } from "../ConsoleShell";
import type { ConsoleData } from "../types";

/**
 * The customer's bucket, their credentials, and what we could prove about it.
 *
 * Only two of the four capability lines are live today —
 * `getStorageBinding` returns `capabilities.conditionalWrite` and a status.
 * The object count, PARA detection, and versioning state are placeholder and
 * are marked as such in `placeholderData.ts`; they need the connect-time probe
 * to persist what it saw.
 */
export function StoragePane({ data }: { data: ConsoleData }) {
  const storage = data.storage;
  const ingestion = useCopy(data.ingestionAddress);

  return (
    <View>
      <PaneHead
        title="Storage"
        description="Your bucket, your credentials. Revoke the key at your provider and Context loses access immediately — no export needed."
        trailing={
          storage ? (
            <Pill
              tone={storage.connected ? "ok" : "warn"}
              leading={<Dot tone={storage.connected ? "ok" : "warn"} />}
            >
              {storage.connected ? "Connected" : "Not verified"}
            </Pill>
          ) : undefined
        }
      />

      {storage === null ? (
        <Card>
          <Text variant="rowTitle">No bucket connected</Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {data.loading
              ? "Loading…"
              : "Context stores nothing of its own. Connect an S3-compatible bucket you own and every note stays in it."}
          </Text>
        </Card>
      ) : (
        <Card>
          <FieldGrid
            fields={[
              { label: "Provider", value: storage.provider },
              { label: "Bucket", value: storage.bucket },
              { label: "Endpoint", value: storage.endpoint },
              { label: "Access key", value: storage.accessKey },
            ]}
          />

          <View style={styles.checks}>
            <Check tone="ok">{`Reachable — ${storage.objectCount} objects`}</Check>
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
            {storage.lastError ? <Check tone="warn">{storage.lastError}</Check> : null}
          </View>

          <Row style={styles.actions}>
            <Button label="Re-verify" disabled={data.demo} />
            <Button label="Rotate key" disabled={data.demo} />
            <Button label="Disconnect" variant="danger" disabled={data.demo} />
          </Row>
        </Card>
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

const styles = StyleSheet.create({
  rowSub: { marginTop: 2 },
  checks: {
    marginTop: 15,
    gap: 8,
  },
  actions: { marginTop: 17, gap: 9 },
  spaced: { marginTop: 11 },
  spacedTight: { marginTop: 11 },
  inlineMono: { fontSize: 12 },
});

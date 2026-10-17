import { useState } from "react";
import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { EXPORT_PROMISE, managedMigrationCopy, premiumStateOf, type PremiumView } from "./premium";
import { foundingAtNoCharge } from "./founding";

/** The native companion displays the current plan without selling it. */
export function NativePlan({ view, onOpenStorage, onDownload }: {
  view: PremiumView;
  onOpenStorage?: () => void;
  onDownload?: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const migration = view.status === null ? null : managedMigrationCopy(view.status);
  const state = premiumStateOf(view.status?.status);
  return (
    <View>
      <Text variant="paneTitle">Current plan</Text>
      <Card>
        <Text variant="rowTitle" testID="native-plan-title">
          {view.status === null ? (view.loading ? "Loading…" : "Plan unavailable") :
            state === "premium" ? "Premium" : view.status.freeManaged ? "Free storage" :
              state === "free" ? "Free plan" : "Subscription status"}
        </Text>
        <Text variant="rowSub">This app uses the storage and features available to this brain or workspace.</Text>
      </Card>
      {typeof view.status?.noteCap === "number" && (state !== "premium" || foundingAtNoCharge(view.status)) ? (
        <Text variant="rowSub">
          {`${foundingAtNoCharge(view.status) ? "Founding member" : "Free storage"}: ${(view.status.notes ?? 0).toLocaleString("en-US")} of ${view.status.noteCap.toLocaleString("en-US")} notes.`}
        </Text>
      ) : null}
      {migration === null ? null : <Card testID="managed-storage-migration">
        <Text variant="rowTitle">{migration.title}</Text>
        <Text variant="rowSub">{migration.body}</Text>
        {migration.percent === undefined ? null : <Text variant="foot">{migration.percent}% through this step</Text>}
        {migration.failed && migration.canRetry !== false && view.retryManagedStorage ? <Button
          label={working ? "Trying again…" : "Try copy again"}
          disabled={working}
          testID="managed-storage-retry"
          onPress={() => {
            if (working) return;
            setWorking(true); setFailed(false);
            void view.retryManagedStorage!().catch(() => setFailed(true)).finally(() => setWorking(false));
          }}
        /> : null}
        {failed ? <Text variant="foot" role="status">That did not go through. Check your connection and try again.</Text> : null}
      </Card>}
      {onOpenStorage ? <Button label="Storage settings" onPress={onOpenStorage} /> : null}
      {onDownload ? <Button label="Download all notes" onPress={onDownload} /> : null}
      <Text variant="foot">{EXPORT_PROMISE}</Text>
    </View>
  );
}

import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { EXPORT_PROMISE, premiumStateOf, type PremiumView } from "./premium";

/** The native companion displays the current plan without selling it. */
export function NativePlan({ view, onOpenStorage, onDownload }: {
  view: PremiumView;
  onOpenStorage?: () => void;
  onDownload?: () => void;
}) {
  const state = premiumStateOf(view.status?.status);
  return (
    <View>
      <Text variant="paneTitle">Current plan</Text>
      <Card>
        <Text variant="rowTitle">
          {view.status === null ? (view.loading ? "Loading…" : "Plan unavailable") :
            view.status.freeManaged ? "Free storage" : state === "premium" ? "Premium" :
              state === "free" ? "Free plan" : "Subscription status"}
        </Text>
        <Text variant="rowSub">This app uses the storage and features available to this brain or workspace.</Text>
      </Card>
      {typeof view.status?.noteCap === "number" ? (
        <Text variant="rowSub">
          {`Free storage: ${(view.status.notes ?? 0).toLocaleString("en-US")} of ${view.status.noteCap.toLocaleString("en-US")} notes.`}
        </Text>
      ) : null}
      {onOpenStorage ? <Button label="Storage settings" onPress={onOpenStorage} /> : null}
      {onDownload ? <Button label="Download all notes" onPress={onDownload} /> : null}
      <Text variant="foot">{EXPORT_PROMISE}</Text>
    </View>
  );
}

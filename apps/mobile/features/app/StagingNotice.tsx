import { Notice } from "../design/components/Input";
import { Text } from "../design/components/Text";

export const STAGING_DATA_WARNING = "Staging is for testing only. Data may be deleted at any time. Do not store vital information or your only copy here.";

export function StagingNotice() {
  if (process.env.EXPO_PUBLIC_SITE_ORIGIN !== "https://staging.context.lc") return null;
  return (
    <Notice tone="warn" testID="staging-data-warning">
      <Text variant="rowSub" role="alert">{STAGING_DATA_WARNING}</Text>
    </Notice>
  );
}

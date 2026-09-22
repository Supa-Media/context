import { Pill } from "../design/components/Pill";

export const STAGING_DATA_WARNING = "Staging is for testing only. Data may be deleted at any time. Do not store vital information or your only copy here.";

export function StagingPill() {
  if (process.env.EXPO_PUBLIC_SITE_ORIGIN !== "https://staging.context.lc") return null;
  return <Pill tone="warn" style={{ alignSelf: "center" }} testID="staging-pill">Staging</Pill>;
}

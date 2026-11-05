import { useLocalSearchParams } from "expo-router";
import { InstallPage } from "../features/install/InstallPage";
import type { InstallTab } from "../features/install/installGuide";

const TABS: readonly InstallTab[] = ["mac", "linux", "headless"];

/** `context.lc/download` (`?tab=linux|headless` opens that tab). `/download/mac` and the rest stay the router's redirects. */
export default function DownloadRoute() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const initial = TABS.find((t) => t === tab) ?? "mac";
  return <InstallPage key={initial} initialTab={initial} />;
}

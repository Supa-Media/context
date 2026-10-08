/**
 * The AI costs tab: the one place that holds which account is open.
 *
 * It reads its data through `./aiCostsData` and draws `./AiCostsView`; opening
 * an account draws `./AiCostsAccount` as a drawer beside the page on a
 * pointer, and as the whole screen on a phone. Nothing here does arithmetic.
 *
 * The window is the console's 7 / 30 / 90 picker, passed in from `AdminPane`.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useThemedStyles } from "../design";
import { useCompact } from "./AdminKit";
import { AiCostsAccount } from "./AiCostsAccount";
import { useAiCostsAccount, useAiCostsData } from "./aiCostsData";
import { AiCostsView } from "./AiCostsView";

export function AiCostsSection({ days }: { days: number }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [openId, setOpenId] = useState<string | null>(null);
  const { report, cloudflare } = useAiCostsData(days);
  const account = useAiCostsAccount(openId, days);
  const close = () => setOpenId(null);

  if (openId !== null && compact) {
    return <AiCostsAccount account={account} onClose={close} />;
  }

  const view = <AiCostsView report={report} cloudflare={cloudflare} onOpenAccount={setOpenId} />;
  if (openId === null) return <View testID="admin-ai-costs-section">{view}</View>;

  // The page stays behind the drawer, faded and not to be pressed.
  return (
    <View style={styles.split} testID="admin-ai-costs-section">
      <View style={styles.behind} pointerEvents="none">
        {view}
      </View>
      <AiCostsAccount account={account} onClose={close} />
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    split: { flexDirection: "row", alignItems: "stretch" },
    behind: { flex: 1, minWidth: 0, opacity: 0.4 },
  });

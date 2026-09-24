import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { leading, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { PaymentStep } from "../../../onboarding/redesign/PaymentStep";
import { formatBytes, formatPrice, type PremiumStatus } from "./premium";

/**
 * Where a context on the free managed tier stands against its note cap.
 *
 * `null` for every context without a cap — paying, on a bucket the customer
 * owns, or never on the free tier. The count is the binding's own (`notes`,
 * owner-only, taken when the storage was last verified), so it can lag a few
 * writes behind; the gateway enforces the cap on the live count, and this only
 * decides what the panel says.
 */
export function freeTierUsage(
  status: PremiumStatus | null,
): { used: number; cap: number; full: boolean } | null {
  if (status === null || typeof status.noteCap !== "number") return null;
  const used = typeof status.notes === "number" ? status.notes : 0;
  return { used, cap: status.noteCap, full: used >= status.noteCap };
}

/**
 * A-12, in Settings › Premium: a usage line while there is room, the nudge
 * once the cap is reached. Never a lock — the nudge itself says what still
 * works — and its two ways forward are only drawn where they can act.
 */
export function FreeTierNudge({
  status,
  onLevelUp,
  onBringOwn,
}: {
  status: PremiumStatus | null;
  /** Absent for a member, who cannot change what the context pays for. */
  onLevelUp?: () => void;
  /** Absent where the panel has no Storage section to open. */
  onBringOwn?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const usage = freeTierUsage(status);
  if (status === null || usage === null) return null;
  if (!usage.full) {
    return (
      <View style={styles.line} testID="premium-free-usage">
        <Text variant="rowSub" style={styles.lineText}>
          {`Free plan: ${usage.used.toLocaleString("en-US")} of ${usage.cap.toLocaleString("en-US")} notes.`}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.nudge} testID="premium-free-nudge">
      <PaymentStep
        used={usage.used}
        cap={usage.cap}
        monthly={formatPrice(status)}
        ceiling={formatBytes(status.ceilingBytes)}
        onLevelUp={onLevelUp}
        onBringOwn={onBringOwn}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    line: { marginBottom: space.x4 },
    lineText: { color: colors.text2, lineHeight: leading(12.5, 1.6) },
    nudge: { marginBottom: space.x5 },
  });

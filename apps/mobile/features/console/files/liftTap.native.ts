import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * The little tap a finger feels on iPhone as a held row lifts (the owner,
 * 2026-10-16). Optional, because an over-the-air update reaches native builds
 * older than the haptics module: there a hold lifts in silence rather than
 * failing. `"medium"` is `ImpactFeedbackStyle.Medium`.
 */
const haptics = requireOptionalNativeModule<{ impactAsync?: (style: string) => Promise<void> }>("ExpoHaptics");

export function liftTap(): void {
  void haptics?.impactAsync?.("medium")?.catch(() => {});
}

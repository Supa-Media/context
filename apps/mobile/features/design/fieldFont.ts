import { useWindowDimensions } from "react-native";
import { densityFor } from "../app/frame";
import { touchType } from "./tokens";

/**
 * The smallest type a text field may have on a phone: 16px.
 *
 * Mobile Safari zooms the whole page when a field set under 16px takes focus,
 * and leaves it zoomed after the field loses it, so a person who tapped one box
 * pinches their way back out of every screen with a form on it (the owner's
 * phone pass, 2026-09-27). React Native Web renders a `TextInput` as a real
 * `<input>`, so the rule is the browser's and applies to every field here —
 * including one with no `fontSize` at all, which RN-Web draws at 14px.
 *
 * Only the phone layout is raised. A pointer layout keeps the console's own
 * scale (`pointerType.ui` 13, `lede` 15), where nothing zooms.
 */
export const FIELD_MIN_PHONE = touchType.ui;

/** `size`, raised to `FIELD_MIN_PHONE` on a phone. */
export function fieldFontSize(size: number, compact: boolean): number {
  return compact ? Math.max(size, FIELD_MIN_PHONE) : size;
}

/**
 * The style a field adds last: `FIELD_MIN_PHONE` as its size on a phone when its
 * own size is under that, and nothing otherwise, so a desktop field is the
 * size it always was. Pass the field's own size; leave it out for a field that
 * sets none.
 *
 * `__tests__/fieldFont.test.ts` holds every `TextInput` in the app to calling
 * this or saying why it need not.
 */
export function useFieldFont(size = 0): { fontSize: number } | undefined {
  const compact = densityFor(useWindowDimensions().width) === "compact";
  return compact && size < FIELD_MIN_PHONE ? { fontSize: FIELD_MIN_PHONE } : undefined;
}

/**
 * The Context design system.
 *
 * The measures and the dark palette are lifted from
 * `docs/design/console-mockup.html`, which is the signed-off design; the light
 * palette is designed against it. Screens compose these primitives; they
 * should not re-declare colours, type sizes, or radii of their own.
 *
 * Colours come through `useColors()` / `useThemedStyles()`, not by importing a
 * palette — see `./theme`.
 */
export {
  darkColors,
  lightColors,
  darkGraphColors,
  lightGraphColors,
  darkShadows,
  lightShadows,
  fonts,
  radii,
  space,
  layout,
  clamp,
  tracking,
  leading,
} from "./tokens";
export type { Colors, GraphColors, GraphKind, Shadows } from "./tokens";

export {
  ThemeProvider,
  resolveScheme,
  useColors,
  useScheme,
  useTheme,
  useThemedStyles,
} from "./theme";
export type { Scheme, StyleFactory, Theme } from "./theme";

export { gradient, repeatingPattern, maskImage } from "./css";
export { segment, distance, angleDegrees, midpoint, scalePoint } from "./geometry";
export type { Point, SegmentBox } from "./geometry";

export { Text, useTextStyles } from "./components/Text";
export type { TextVariant } from "./components/Text";
export { Button, PressRow, WindowDots } from "./components/Button";
export type { ButtonVariant } from "./components/Button";
export { Card, Row, Grow } from "./components/Card";
export { Pill } from "./components/Pill";
export type { PillTone } from "./components/Pill";
export { Dot } from "./components/Dot";
export type { DotTone } from "./components/Dot";
export { CopyField } from "./components/CopyField";
export { Field, FieldGrid, Check, Hint } from "./components/Field";
export type { FieldSpec } from "./components/Field";
export { TextField, ChoiceGroup, FormError, Notice } from "./components/Input";
export type { TextFieldProps, ChoiceOption } from "./components/Input";
export { AutoGrid } from "./components/AutoGrid";
export { autoFitColumns, autoFitItemWidth } from "./grid";
export { withAlpha } from "./color";
export { Line } from "./components/Line";
export { FocusRing } from "./components/FocusRing";
export { StageBackdrop, ConsoleHalo } from "./components/StageBackdrop";

export { useCopy } from "./useCopy";
export { createCopyController, COPY_RESET_MS } from "./copyController";
export { useReducedMotion } from "./useReducedMotion";
export { ensureFontsLoaded, FONT_STYLESHEET_HREF, FONT_STYLESHEET_ID } from "./fonts";
export { writeClipboard } from "./clipboard";

/**
 * Design tokens for Context — the facade.
 *
 * The tokens themselves live under `./tokens/`, split by family: `colors.ts`
 * (the Graphite/Paper palettes and the constellation map's graph colours),
 * `typography.ts` (font families, the type scale, `tracking`/`leading`),
 * `spacing.ts`, `radii.ts`, `layout.ts` (the application frame's measurements,
 * `clamp` and `bottomBarGeometry`) and `shadows.ts` (elevation). This file
 * re-exports every one of them under its original name, so every existing
 * `from "…/design/tokens"` import keeps working unchanged.
 */
export {
  darkColors,
  type Colors,
  lightColors,
  darkGraphColors,
  type GraphKind,
  type GraphColors,
  lightGraphColors,
} from "./tokens/colors";

export {
  fonts,
  pointerType,
  type TypeScale,
  touchType,
  typeFor,
  tracking,
  leading,
} from "./tokens/typography";

export { space } from "./tokens/spacing";

export { radii } from "./tokens/radii";

export {
  layout,
  clamp,
  type BottomBarGeometry,
  bottomBarGeometry,
} from "./tokens/layout";

export { darkShadows, type Shadows, lightShadows } from "./tokens/shadows";

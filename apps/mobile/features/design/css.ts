import { Platform, type ViewStyle } from "react-native";

/**
 * CSS gradients from a React Native style object.
 *
 * The two platforms spell this differently and neither spelling is in the
 * shared `ViewStyle` type:
 *
 *  - **Web** — RN-Web hyphenates unrecognised style keys straight into CSS, so
 *    `backgroundImage` lands as `background-image` and any CSS gradient works.
 *  - **Native** — Fabric implements gradients as `experimental_backgroundImage`
 *    and ignores `backgroundImage` entirely.
 *
 * Callers should always paint a flat `backgroundColor` underneath as well, so
 * that a platform which drops the gradient still gets a solid, on-palette
 * surface rather than a transparent hole.
 */
export function gradient(css: string): ViewStyle {
  return Platform.OS === "web"
    ? ({ backgroundImage: css } as unknown as ViewStyle)
    : ({ experimental_backgroundImage: css } as ViewStyle);
}

/**
 * `background-image` used as a repeating pattern rather than a gradient fill —
 * the faint engineering grid behind the hero. Same platform split, plus the
 * `background-size` that makes the 1px lines repeat on a 64px pitch.
 *
 * Native has no `background-size`, so native callers get nothing here and
 * should fall back to drawing the grid with Views if it ever matters there.
 */
export function repeatingPattern(css: string, size: string): ViewStyle {
  if (Platform.OS !== "web") return {};
  return {
    backgroundImage: css,
    backgroundSize: size,
  } as unknown as ViewStyle;
}

/**
 * The mockup masks the grid with a radial gradient so it fades out at the
 * edges. `mask-image` is web-only and has no RN equivalent.
 */
export function maskImage(css: string): ViewStyle {
  if (Platform.OS !== "web") return {};
  return {
    maskImage: css,
    WebkitMaskImage: css,
  } as unknown as ViewStyle;
}

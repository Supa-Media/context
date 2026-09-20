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
 * A region exactly one viewport tall, that the page cannot scroll past.
 *
 * The application frame owns the screen: the browser window *is* the window,
 * the four regions scroll individually, and the document itself never moves.
 * Saying that costs a platform split because the two platforms disagree about
 * what "the viewport" is:
 *
 *  - **Web** — `100dvh`, the *dynamic* viewport unit. `100vh` is the wrong one
 *    on a phone: mobile Safari and Chrome both measure it against the viewport
 *    with the URL bar **hidden**, so a `100vh` app frame is roughly 60–100px
 *    taller than the screen and its bottom toolbar sits underneath the browser
 *    chrome, permanently out of reach. `dvh` tracks the bar as it collapses.
 *    This is the single most common way a web app feels broken on a phone, and
 *    it is invisible on a desktop.
 *  - **Native** — there are no viewport units and no browser chrome; the root
 *    view is already the screen, so `flex: 1` fills it.
 */
export function viewportHeight(insetPx = 0): ViewStyle {
  if (Platform.OS !== "web") return { flex: 1 };
  /*
    `insetPx` is what something *above* this region already took out of the
    window — today only the desktop shell's title band. Without it the frame
    is a full viewport tall *underneath* a 38px band, so it hangs 38px past
    the bottom of the window and the console's footer row is clipped by
    exactly that much. `calc` rather than `100dvh` minus a margin, because the
    unit has to stay dynamic: the subtraction is a constant, the viewport is
    not.
  */
  const height = insetPx === 0 ? "100dvh" : `calc(100dvh - ${insetPx}px)`;
  return { height, maxHeight: height } as unknown as ViewStyle;
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

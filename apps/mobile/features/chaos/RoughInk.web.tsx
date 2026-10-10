import { createElement as h, useId, type ReactNode } from "react";

/**
 * The figure's brush edge in a browser: paper3's `#rough` filter, as written
 * on the board the owner picked — the edge displaced by low-frequency noise,
 * then pitted with fine grain where the brush ran dry.
 *
 * Raw SVG elements rather than react-native-svg's filter components:
 * react-native-svg on the web renders a real `<svg>`, so these land in it as
 * they would in paper3's page, and every browser this app ships to draws
 * them. `rough: false` (a tiny figure, where the grain is below a pixel and
 * only greys the ink) draws plain strokes. `RoughInk.tsx` is the native half.
 */
export function RoughInk({ children, rough }: { children: ReactNode; rough: boolean }) {
  const id = `chaos-rough-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (!rough) return h("g", null, children);
  return h(
    "g",
    null,
    h(
      "defs",
      null,
      h(
        "filter",
        { id, x: "-10%", y: "-10%", width: "120%", height: "120%" },
        h("feTurbulence", { type: "fractalNoise", baseFrequency: "0.035", numOctaves: "2", seed: "4", result: "n" }),
        h("feDisplacementMap", {
          in: "SourceGraphic",
          in2: "n",
          scale: "7",
          xChannelSelector: "R",
          yChannelSelector: "G",
          result: "d",
        }),
        h("feTurbulence", { type: "fractalNoise", baseFrequency: "0.9", numOctaves: "1", seed: "9", result: "grain" }),
        h("feColorMatrix", {
          in: "grain",
          type: "matrix",
          values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.5 1.95",
          result: "holes",
        }),
        h("feComposite", { in: "d", in2: "holes", operator: "in" }),
      ),
    ),
    h("g", { filter: `url(#${id})`, "data-testid": "chaos-figure-rough" }, children),
  );
}

import { createElement as h, useId, type ReactNode } from "react";

/**
 * Graphite grain in a browser: the stroke's alpha pitted by fine noise, so a
 * line reads as pencil on paper (chalk on the dark board, a little coarser and
 * softened). Raw SVG elements, as `chaos/RoughInk.web.tsx` does, because
 * react-native-svg on the web renders a real `<svg>`. `SketchGrain.tsx` is the
 * native half.
 */
export function SketchGrain({ children, dark }: { children: ReactNode; dark: boolean }) {
  const id = `sketch-grain-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return h(
    "g",
    null,
    h(
      "defs",
      null,
      h(
        "filter",
        { id, x: "-10%", y: "-30%", width: "120%", height: "160%" },
        h("feTurbulence", { type: "fractalNoise", baseFrequency: dark ? "1.35" : "1.6", numOctaves: "1", seed: "4", result: "n" }),
        h("feColorMatrix", {
          in: "n",
          type: "matrix",
          values: dark ? "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.6" : "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.2 1.4",
          result: "m",
        }),
        h("feComposite", { in: "SourceGraphic", in2: "m", operator: "in" }),
      ),
    ),
    h("g", { filter: `url(#${id})`, "data-testid": "sketch-grain" }, children),
  );
}

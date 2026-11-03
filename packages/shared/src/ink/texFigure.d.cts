/** Types for `texFigure.cjs`; see that file for Tex's geometry and where it came from. */

export type Point = readonly [number, number];

export interface FigureParts {
  /** The four strands, each with its dry second pass, at their stroke width. */
  strands: { d: string; dry: string; width: number }[];
  limbs: { d: string; width: number }[];
  limbOpacity: number;
  speckles: { cx: number; cy: number; r: number; opacity: number }[];
  motion: { d: string[]; width: number; opacity: number } | null;
  /** The strand Tex tugs at, from its body to its hand; only in the tugging pose. */
  yarn: { d: string; width: number } | null;
  /** The googly eyes, about (CX, CY - 10) at `scale`. Tex keeps them even when calm. */
  googly: {
    x: number;
    y: number;
    scale: number;
    outline: number;
    whites: { cx: number; cy: number; rx: number; ry: number }[];
    pupils: { cx: number; cy: number; r: number }[];
  };
  viewBox: string;
}

export declare const SMALL_FIGURE: number;
export declare const VIEW_BOX: { readonly x: number; readonly y: number; readonly size: number };
export declare const SMALL_VIEW_BOX: { readonly x: number; readonly y: number; readonly size: number };
export declare const TEX_WIDTH: number;
export declare const CX: number;
export declare const CY: number;
export declare function scribble(seed: number, count?: number, radius?: number): readonly Point[];
export declare function figureParts(
  chaos: number,
  options: { small: boolean; minStroke?: number; seed?: number; tug?: number },
): FigureParts;

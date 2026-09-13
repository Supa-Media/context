/**
 * Types for `@context/drawings`.
 *
 * The implementation is plain ESM so the gateway can import it by relative path
 * with no build step and no dependency — the same arrangement
 * `packages/meetings` uses, and for the same reason
 * (`apps/mcp/src/index.js` explains it). TypeScript consumers get this instead
 * of inference over JSDoc, because the scene a renderer is handed is a
 * discriminated union and inference flattens it into `unknown`, which is how
 * `DrawingView` first came out untyped.
 *
 * Kept deliberately narrow: this describes the surface `index.js` exports and
 * nothing about the internals, so the two can only disagree about names.
 */

/** One label the plugin wrote into the Markdown half of the file. */
export interface DrawingTextElement {
  /** The plugin's block id (`^a1b2c3`), or null when the line carried none. */
  id: string | null;
  text: string;
}

/**
 * An Excalidraw element, as the payload stores it.
 *
 * Loose on purpose. Excalidraw adds fields every release and this package must
 * keep reading a file written by a version it has never seen, so the known
 * fields are typed and the rest is left open rather than enumerated into a list
 * that goes stale.
 */
export interface DrawingElement {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  text?: string;
  link?: string | null;
  containerId?: string | null;
  isDeleted?: boolean;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  [key: string]: unknown;
}

/** Why a payload could not be read. Null when it was. */
export type DrawingUnreadable = "missing" | "oversized" | "undecodable" | "unrecognised" | null;

export interface Drawing {
  /** The file's stem, both extensions removed. */
  name: string;
  textElements: DrawingTextElement[];
  /** element id -> link target, from the `Element Links` section. */
  elementLinks: Map<string, string>;
  /** file id -> target, from the `Embedded Files` section. */
  embeddedFiles: Map<string, string>;
  /** Null exactly when `unreadable` is not null. */
  elements: DrawingElement[] | null;
  appState: Record<string, unknown> | null;
  /** True when the element list was cut at `MAX_ELEMENTS`. */
  truncated: boolean;
  unreadable: DrawingUnreadable;
  payloadChars: number;
}

export interface SceneRotation {
  degrees: number;
  cx: number;
  cy: number;
}

interface SceneNodeBase {
  id: string;
  stroke: string;
  strokeWidth: number;
  strokeDasharray: number[] | null;
  opacity: number;
  rotate: SceneRotation | null;
}

interface SceneFill {
  fill: string;
  fillOpacity: number;
}

export interface SceneRect extends SceneNodeBase, SceneFill {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  /** True for an image or embed, which is drawn as its box and nothing else. */
  placeholder: boolean;
}

export interface SceneEllipse extends SceneNodeBase, SceneFill {
  kind: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface ScenePolygon extends SceneNodeBase, SceneFill {
  kind: "polygon";
  points: [number, number][];
}

export interface ScenePath extends SceneNodeBase, SceneFill {
  kind: "path";
  d: string;
}

export interface SceneTextLine {
  text: string;
  x: number;
  /** A baseline, not a top edge — the caller draws at this point as given. */
  y: number;
}

export interface SceneText extends SceneNodeBase {
  kind: "text";
  anchor: "start" | "middle" | "end";
  fontSize: number;
  fontFamily: "hand" | "sans" | "mono";
  fill: string;
  lines: SceneTextLine[];
}

export type SceneNode = SceneRect | SceneEllipse | ScenePolygon | ScenePath | SceneText;

export interface Scene {
  viewBox: { x: number; y: number; width: number; height: number };
  /** In paint order, which is Excalidraw's own array order. */
  nodes: SceneNode[];
  truncated: boolean;
}

export declare const DRAWING_SUFFIX: string;
export declare const MAX_ELEMENTS: number;
export declare const MAX_PAYLOAD_CHARS: number;
export declare const SCENE_PADDING: number;

export declare function isDrawingPath(key: unknown): boolean;
export declare function drawingName(key: unknown): string;
export declare function parseDrawing(text: unknown, key?: string): Drawing;
export declare function describeDrawing(drawing: Drawing, options?: { path?: string }): string;
export declare function drawingSearchText(drawing: Drawing): string;
export declare function boundingBox(
  elements: DrawingElement[]
): { x: number; y: number; width: number; height: number } | null;
export declare function buildScene(
  elements: DrawingElement[] | null | undefined,
  options?: { padding?: number; maxNodes?: number }
): Scene;
/**
 * The new file body for `elements`, or null when `original` is not a drawing
 * this can splice safely. Always an edit of `original`, never a regeneration —
 * see the module header for what that protects.
 */
export declare function serializeDrawing(
  original: unknown,
  elements: DrawingElement[],
  options?: { appState?: Record<string, unknown> | null; files?: Record<string, unknown> | null }
): string | null;

/** Whether `serializeDrawing` would produce a file for this original. */
export declare function canSerializeDrawing(original: unknown): boolean;

export declare function compressToBase64(input: string | null | undefined): string;
export declare function decompressFromBase64(input: unknown): string | null;

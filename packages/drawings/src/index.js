/**
 * Excalidraw drawings, as Context treats them.
 *
 * A `.excalidraw.md` file is a note the gateway must not read as prose and a
 * picture the console should draw. `excalidraw.js` parses one without rewriting
 * it; `scene.js` lays the result out for a renderer. Both are pure, both are
 * zero-dependency, and both are imported by the Worker by relative path — see
 * `apps/mcp/src/index.js` for why that is the arrangement.
 */

export {
  DRAWING_SUFFIX,
  MAX_ELEMENTS,
  MAX_PAYLOAD_CHARS,
  boundingBox,
  describeDrawing,
  drawingName,
  drawingSearchText,
  isDrawingPath,
  parseDrawing,
} from "./excalidraw.js";

export { SCENE_PADDING, buildScene } from "./scene.js";
export { canSerializeDrawing, serializeDrawing } from "./serialize.js";
export { compressToBase64, decompressFromBase64 } from "./lzstring.js";

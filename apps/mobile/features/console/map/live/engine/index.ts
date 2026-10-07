/**
 * The live map's canvas engine. Pure TypeScript: no React, no Convex, no
 * network. `createMapEngine` is the whole of what the app needs; the rest is
 * exported for the panels that follow the map (replay bar, folder counts,
 * the followed AI's reading list) and for tests.
 */
export { createMapEngine, type MapEngine, type MapEngineOptions } from "./engine";
export type { MapData } from "./model";
export { mapPalette, type MapPalette } from "./palette";
export type { CameraDetail, Inset, Cam } from "./camera";
export type { HitTarget } from "./hit";
export type { FollowState } from "./follow";
export type { FaceFor, Who } from "./draw/primitives";
export {
  actorsAt,
  folderCountsAt,
  highwaysAt,
  histogram,
  momentsOf,
  presentAt,
  readsAt,
  type Highway,
  type MapActor,
} from "./timeline";
export { buildLayout, type Layout } from "./layout";
export { folderLabel, sortFolders } from "./paths";

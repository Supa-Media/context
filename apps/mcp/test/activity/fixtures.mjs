/**
 * Shared fixtures for `test/activity/*.test.mjs`, split out of the original
 * activity.test.mjs — see activity.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import worker from "../../src/index.js";
import { R2Store } from "../../src/store/r2.js";
import {
  ACTIVITY_PATH,
  MAX_ENTRIES,
  MIN_REVISION_BYTES,
  REFRESH_MS,
  applyEntry,
  describeEntry,
  entryFor,
  mayBeReportable,
  nextFile,
  parseFile,
  renderFile,
  repairPrompt,
  strayRows,
  unseenCount,
  unseenPaths,
  visibleEntries,
} from "../../../../packages/shared/src/activity.cjs";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
} from "../controlPlaneStub.mjs";

export {
  worker,
  R2Store,
  ACTIVITY_PATH,
  MAX_ENTRIES,
  MIN_REVISION_BYTES,
  REFRESH_MS,
  applyEntry,
  describeEntry,
  entryFor,
  mayBeReportable,
  nextFile,
  parseFile,
  renderFile,
  repairPrompt,
  strayRows,
  unseenCount,
  unseenPaths,
  visibleEntries,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
};

export const T0 = Date.parse("2026-09-19T10:00:00.000Z");
export const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

export const claude = { name: "@sayo", client: "Claude" };
export const seyi = { name: "@seyi", client: null };

export function change(action, paths, details = {}, actor = claude, at = iso(0)) {
  return { action, paths, details, actor, at };
}

/** Far enough apart that nothing merges: one entry per iteration. */
export const GROUP_ESCAPE = 60 * 60 * 1000;

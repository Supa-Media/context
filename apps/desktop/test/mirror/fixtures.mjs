/**
 * Shared fixtures for the offline-mirror suite, split out of
 * `mirror.test.mjs` so each behavioural slice can stay under the file-size
 * ceiling. Not a test module itself — it exports no `run*Checks` and the
 * runner does not discover it. Also re-exports the source module's members
 * both slices need, so each imports everything from this one place.
 */

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ERR_ABORTED,
  MIRROR_FAILURE_PATH,
  MIRROR_FORMAT,
  MIRROR_LIMITS,
  MIRROR_NOTICE,
  MIRROR_ORIGIN,
  MIRROR_REFUSALS,
  OFFLINE_NOTICE_ID,
  awaitFallbackSettled,
  declaresTooManyBytes,
  failurePage,
  fitsInBudget,
  isAllowedConsoleNavigation,
  mirrorIsUsable,
  mirrorKey,
  mirrorSnapshotUrls,
  pinnedOriginFor,
  resolveMirrorRequest,
  respondToFailedLoad,
  shouldMirror,
  smokeLoadFailure,
  wasMirrorServed,
  withOfflineNotice,
} from "../../src/core/shell/mirror.ts";
import { MirrorStore } from "../../src/main/mirrorStore.ts";

export {
  EventEmitter,
  readFileSync,
  mkdtemp,
  rm,
  symlink,
  writeFile,
  tmpdir,
  join,
  ERR_ABORTED,
  MIRROR_FAILURE_PATH,
  MIRROR_FORMAT,
  MIRROR_LIMITS,
  MIRROR_NOTICE,
  MIRROR_ORIGIN,
  MIRROR_REFUSALS,
  OFFLINE_NOTICE_ID,
  awaitFallbackSettled,
  declaresTooManyBytes,
  failurePage,
  fitsInBudget,
  isAllowedConsoleNavigation,
  mirrorIsUsable,
  mirrorKey,
  mirrorSnapshotUrls,
  pinnedOriginFor,
  resolveMirrorRequest,
  respondToFailedLoad,
  shouldMirror,
  smokeLoadFailure,
  wasMirrorServed,
  withOfflineNotice,
  MirrorStore,
};

export const LIVE = "https://context.lc";
export const APP_VERSION = "0.1.0";

/** A mirrorable response, which every check varies one field of. */
export function candidate(overrides = {}) {
  const { headers, ...rest } = overrides;
  return {
    url: `${LIVE}/console/index.html`,
    liveOrigin: LIVE,
    method: "GET",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    bytes: 4_096,
    ...rest,
  };
}

export function refusal(overrides) {
  const decision = shouldMirror(candidate(overrides));
  return decision.ok ? null : decision.why;
}

/** The manifest shape the store writes, for the pure checks. */
export function manifest(overrides = {}) {
  const index = mirrorKey("/console");
  return {
    format: MIRROR_FORMAT,
    appVersion: APP_VERSION,
    origin: LIVE,
    savedAtMs: 1_700_000_000_000,
    index,
    entries: {
      [index]: { key: index, path: "/console", contentType: "text/html", bytes: 10 },
      [mirrorKey("/assets/app.js")]: {
        key: mirrorKey("/assets/app.js"),
        path: "/assets/app.js",
        contentType: "text/javascript",
        bytes: 20,
      },
    },
    ...overrides,
  };
}

export const NOW = 1_700_000_060_000;

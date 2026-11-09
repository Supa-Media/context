// Every route the gateway's front door serves is reachable at its own address, never read as a workspace name.
//
// The front door splits a first segment off as a workspace selector (`workspacePath.js` `splitWorkspacePath`)
// unless it is a reserved route word. A route whose word was never added answers 404 for everyone, while its own
// suite, which calls its handler directly, stays green. That has happened five times: `meetings`, `agent`,
// `approvals`, `machines`, and on 2026-11-09 `files`, which broke every delete, rename and duplicate in the app.
// So the route table is held to the list here: each route set the front door (`http/route.js`) dispatches on is
// listed, every path in it must survive the split unchanged, and every reserved word must be unclaimable as a
// username in the control plane (`apps/convex/functions/lib/names.ts`), or a person could hold the address.
//
// A new route set goes in ROUTE_SETS below. Sabotage: dropping `files` from RESERVED_FIRST_SEGMENTS fails the first
// case naming `/files/trash`; dropping `files` from the control plane's list fails the second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RESERVED_FIRST_SEGMENTS, splitWorkspacePath } from "../src/workspacePath.js";
import { MACHINE_PATHS } from "../src/machines/routes.js";
import { MACHINE_JOB_PATHS } from "../src/machines/jobRoutes.js";
import { JOB_NOTE_PATHS } from "../src/agent/jobNote.js";
import { MACHINE_APP_PATHS } from "../src/machines/appRoutes.js";
import { APP_ROUTES } from "../src/http/appRoutes.js";
import { TEX_COMPUTER_PATHS } from "../src/http/texComputer.js";
import { TEX_PAGE_PATHS } from "../src/http/texPage/serve.js";
import { APP_SEARCH_PATH } from "../src/http/appSearch.js";
import { TEX_PAGE_SOCKET_PATH } from "../src/http/texPage/live.js";
import { ACCESS_SOCKET_PATH, TREE_SOCKET_PATH } from "../src/live/presenceRoute.js";
import { LIVE_TICKET_PATH } from "../src/live/ticket.js";
import { FILE_OP_PATHS } from "../src/live/fileOpsRoute.js";
import { MEETING_SUMMARY_PATH } from "../src/meetings/summarize.js";
import { TEXTING_ROUTES } from "../src/agent/textingRoutes.js";
import { MOVER_PAGE_PATH } from "../src/moves/mover.js";
import { TEX_STORE_PATH } from "../src/texStore/door.js";
import { THREADS_BACKFILL_PATH } from "../src/agent/threadsBackfillDoor.js";
import { WORKSPACE_STORE_PATH } from "../src/workspaceStore/door.js";
import { IMAGE_UPLOAD_PATH } from "../src/notes/imageUploads.js";

/** Every route set `http/route.js` dispatches on by exact path, by name. */
const ROUTE_SETS = {
  MACHINE_PATHS,
  MACHINE_JOB_PATHS,
  JOB_NOTE_PATHS,
  MACHINE_APP_PATHS,
  APP_ROUTES: [...APP_ROUTES.keys()],
  TEX_COMPUTER_PATHS,
  TEX_PAGE_PATHS,
  APP_SEARCH_PATH: [APP_SEARCH_PATH],
  TEX_PAGE_SOCKET_PATH: [TEX_PAGE_SOCKET_PATH],
  LIVE_SOCKETS: [TREE_SOCKET_PATH, ACCESS_SOCKET_PATH, LIVE_TICKET_PATH],
  FILE_OP_PATHS,
  MEETING_SUMMARY_PATH: [MEETING_SUMMARY_PATH],
  TEXTING_ROUTES: [...TEXTING_ROUTES.keys()],
  MOVER_PAGE_PATH: [MOVER_PAGE_PATH],
  TEX_STORE_PATH: [TEX_STORE_PATH],
  THREADS_BACKFILL_PATH: [THREADS_BACKFILL_PATH],
  WORKSPACE_STORE_PATH: [WORKSPACE_STORE_PATH],
  IMAGE_UPLOAD_PATH: [IMAGE_UPLOAD_PATH],
  // Exact paths `route.js` names inline.
  INLINE: ["/mcp", "/mcp/chatgpt", "/mcp/chatgpt/v2", "/inbox", "/agent", "/agent/try", "/agent/review", "/presence", "/collaboration", "/agent-activity", "/approvals"],
};

for (const [name, paths] of Object.entries(ROUTE_SETS)) {
  test(`${name}: every route is reached at its own address, never read as a workspace`, () => {
    const list = [...paths];
    assert.ok(list.length > 0, `${name} lists no paths`);
    for (const path of list) assert.deepEqual(splitWorkspacePath(path), { slug: null, path }, `${name} ${path}`);
  });

  test(`${name}: every route is reached the same way with a workspace named in front of it`, () => {
    for (const path of paths) assert.deepEqual(splitWorkspacePath(`/@someone${path}`), { slug: "someone", path }, `${name} ${path}`);
  });
}

test("every reserved route word is a name nobody can claim in the control plane", () => {
  const names = readFileSync(new URL("../../convex/functions/lib/names.ts", import.meta.url), "utf8");
  const start = names.indexOf("const PRODUCT_RESERVED_NAMES");
  assert.ok(start >= 0, "the control plane's reserved list was found");
  const listed = new Set([...names.slice(start, names.indexOf("];", start)).matchAll(/^\s*"([^"]+)",/gm)].map((match) => match[1]));
  const missing = [];
  for (const word of RESERVED_FIRST_SEGMENTS) {
    // `t` (the retired token prefix) is shorter than any handle, and `.well-known` is no handle's shape.
    if (word.length < 2 || !/^[a-z0-9-]+$/.test(word)) continue;
    if (!listed.has(word)) missing.push(word);
  }
  assert.deepEqual(missing, [], "route words the control plane lets a person claim");
});

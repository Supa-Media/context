/**
 * Moving a note on storage that does not enforce a conditional delete.
 *
 * ## WHY THIS SUITE EXISTS
 *
 * A move is copy-then-delete. The delete was required to carry `If-Match`, so
 * an edit landing between the two halves produced a clean refusal instead of
 * destroying work — the right rule, and the reason `moveSafetyRefusal` existed.
 *
 * **R2 does not enforce `If-Match` on DELETE.** Not assumed: the capability
 * probe declares it, tests it, and every binding in production answered
 * `conditionalDelete: false`. So the guard meant *no note could be moved,
 * anywhere, on the storage this product actually runs on* — single notes,
 * batches, folders and cross-workspace moves alike, each refused with a message
 * blaming the storage provider. `conditionalWrite` and `conditionalCreate` were
 * true the whole time.
 *
 * `retireMovedSource` substitutes the conditional write for the conditional
 * delete: claim the source path with a zero-byte marker under `If-Match`, which
 * is atomic and fails if anybody touched the note, and only then delete — by
 * which point the bytes at that path are ours and cannot be somebody's lost
 * edit.
 *
 * What is proved here:
 *
 *  1. a single note moves on a store with no conditional delete, and the source
 *     is really gone rather than left behind as a duplicate;
 *  2. the conflict this replaces is still a conflict — a stale etag refuses,
 *     the source survives, and no destination is created;
 *  3. a store with **neither** conditional still refuses, naming both, because
 *     "degrade honestly" is the rule and there is no safe move without one;
 *  4. a cross-workspace move works, and leaves the owner's own copy under
 *     `.context/trash/` — the one move whose destination is a different bucket;
 *  4b. `archive_note` is copy-then-delete too, and its delete was unconditional
 *     before this change: it now takes the same guard, and still archives on a
 *     bucket that can enforce neither conditional;
 *  5. thousands of objects move: a folder past the logical threshold cuts over
 *     immediately and materializes in bounded, resumable batches, on a store
 *     with no conditional delete and no server-side copy.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are as measured, against a
 * 3,614-check baseline:
 *
 *  1. **`retireMovedSource` deletes unconditionally**, dropping the `If-Match`
 *     claim — 3 checks failed, all of them the mid-move race: the move reported
 *     success, the destination kept the pre-edit bytes, and the editor's work
 *     was deleted. That is the data loss this design exists to prevent.
 *  2. **`moveSafetyRefusal` stops checking for either conditional** — 1 check
 *     failed: a store that can create safely but not claim safely was allowed
 *     to attempt a move it cannot finish without an unconditional delete.
 *  3. **The trash copy is taken after the source is claimed** rather than
 *     before (reading the key back, as an "after" implementation would have
 *     to) — 1 check failed: trash held the zero-byte marker, which is a backup
 *     of nothing.
 *  4. **`deleteObjectForMove` keeps its old `conditionalDelete` requirement** —
 *     3 checks failed, all in the bulk move: the folder cut over logically and
 *     then could never materialize, leaving every source in place. A move that
 *     starts and cannot finish is worse than one that refuses up front.
 *  5. **`archive_note` goes back to its unconditional delete** — 3 checks
 *     failed: the mid-archive edit was destroyed and the archive kept the older
 *     text. This is the one sabotage that reproduces a fault that was live in
 *     `main` rather than one this change could have introduced.
 *
 * Worth recording, because the first version of this file measured zero on
 * sabotage 1: the stale-etag check a caller supplies is enforced *before*
 * anything is copied, so asserting it proves nothing about the delete-time
 * guard. Only a write that lands mid-request reaches that code, which is why
 * the hook exists.
 *
 * Every value here is obviously fake. This repository is public.
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-move-fallback.test";

/** Owner of the R2-like workspace, and owner of the second one too. */
const TOKEN_OWNER = `cat_movefb_owner_${"0".repeat(24)}`;
/** Owner of a workspace whose backend enforces nothing at all. */
const TOKEN_UNSAFE = `cat_movefb_unsafe_${"0".repeat(23)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  4-archive: private\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * A binding whose declared capabilities are the caller's to choose.
 *
 * The default is production's own answer for managed R2: conditional writes and
 * creates enforced, conditional delete not, and no server-side copy — so the
 * move path under test also exercises the read-and-write copy fallback rather
 * than the cheap same-store one.
 */
function binding(bucket, key, capabilities = {}) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: false,
      serverSideCopy: false,
      ...capabilities,
    },
    status: "active",
  };
}

async function callTool(env, tokenValue, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return body?.result;
}

const textOf = (result) => result?.content?.[0]?.text || "";

function collaborationHeads(bucket) {
  return [...bucket]
    .filter(([key]) => key.startsWith(".context/collaboration/v1/heads/"))
    .flatMap(([, value]) => {
      try {
        return [JSON.parse(value.body)];
      } catch {
        return [];
      }
    });
}

export async function runMoveWithoutConditionalDeleteChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  // A seam for one check: something has to be able to edit a note *during* a
  // move, because that is the race the conditional guard exists for and it
  // cannot be produced from outside the request. Same device as
  // `crossContext.test.mjs` uses.
  const hooks = [];
  const originalHandle = s3.handle;
  s3.handle = async (url, init = {}) => {
    for (const hook of [...hooks]) await hook(url, init);
    return originalHandle(url, init);
  };
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace("ws_r2like", "r2like", binding("move-r2like", "AA"));
  controlPlane.addWorkspace("ws_second", "second", binding("move-second", "BB"));
  // Conditional *create* left on deliberately, so this fixture isolates the new
  // guard rather than tripping the older create check one line above it. A real
  // B2 or Wasabi binding enforces neither and is refused by that first check,
  // which the suite already covers; what has never been covered is a store that
  // can create safely and cannot claim safely, which is precisely the case the
  // fallback must not attempt.
  controlPlane.addWorkspace(
    "ws_unsafe",
    "unsafe",
    binding("move-unsafe", "CC", { conditionalWrite: false })
  );

  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: "ws_r2like",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_movefb",
    userId: "user_movefb",
    alsoMemberOf: [{ workspaceId: "ws_second", role: "owner" }],
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_UNSAFE,
    workspaceId: "ws_unsafe",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_movefb_unsafe",
    userId: "user_movefb_unsafe",
  });

  const primary = s3.bucketFor("move-r2like");
  const second = s3.bucketFor("move-second");
  const unsafe = s3.bucketFor("move-unsafe");
  for (const [bucket, tag] of [
    [primary, "p"],
    [second, "s"],
    [unsafe, "u"],
  ]) {
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: `${tag}0` });
    bucket.set("index.md", { body: "INDEX", etag: `${tag}i` });
  }

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
  };

  /* ------------------------------ 1. one note ----------------------------- */

  primary.set("1-projects/plain.md", { body: "PLAIN-MARKER", etag: "p1" });
  const moved = await callTool(env, TOKEN_OWNER, "move_note", {
    source: "1-projects/plain.md",
    destination: "1-projects/renamed.md",
  });
  check(
    "a note moves on a store with no conditional delete",
    !moved?.isError && /moved: /.test(textOf(moved))
  );
  check(
    "...and the destination holds the bytes",
    primary.get("1-projects/renamed.md")?.body === "PLAIN-MARKER"
  );
  const oldSourceRead = await callTool(env, TOKEN_OWNER, "read_note", {
    path: "1-projects/plain.md",
  });
  check(
    "...and the old source forwards to the one live destination rather than becoming a duplicate",
    !oldSourceRead?.isError &&
      textOf(oldSourceRead).includes("path: 1-projects/renamed.md") &&
      textOf(oldSourceRead).includes("moved_from: 1-projects/plain.md")
  );
  check(
    "...and a same-workspace move writes no trash copy, because the destination is one",
    [...primary.keys()].every((key) => !key.startsWith(".context/trash/"))
  );

  /* --------------------------- 2. the conflict ---------------------------- */

  // A stale etag the caller supplied is refused before anything is copied, and
  // that guard predates this change. It is asserted anyway, because it is the
  // cheap half and a regression in it would look like this feature.
  primary.set("1-projects/raced.md", { body: "RACED-MARKER", etag: "p2" });
  const stale = await callTool(env, TOKEN_OWNER, "move_note", {
    source: "1-projects/raced.md",
    destination: "1-projects/raced-moved.md",
    expected_source_etag: "an-etag-nobody-has",
  });
  check("a stale etag the caller passed still refuses the move", stale?.isError === true);
  check(
    "...and the source survives untouched",
    primary.get("1-projects/raced.md")?.body === "RACED-MARKER"
  );
  check(
    "...and no destination was created",
    primary.get("1-projects/raced-moved.md") === undefined
  );

  /*
    THE RACE THE GUARD ACTUALLY EXISTS FOR, AND THE ONLY WAY TO STAGE IT.

    An etag the caller passed is checked before the copy. The dangerous edit is
    the one that lands *after* the source has been read and copied, while the
    move is still in flight — nothing outside the request can produce that, so
    the hook edits the note the instant the destination is written.

    Without the conditional claim in `retireMovedSource` this is the data loss
    the whole design is about: the move reports success, the destination holds
    the OLD bytes, and the editor's work is deleted. With it, the move refuses
    and their edit is what survives.
  */
  primary.set("1-projects/inflight.md", { body: "INFLIGHT-ORIGINAL", etag: "p9" });
  let edited = false;
  const editDuringMove = async (url, init = {}) => {
    if ((init.method || "GET").toUpperCase() !== "PUT") return;
    if (!url.includes("/move-r2like/1-projects/inflight-moved.md")) return;
    if (edited) return;
    edited = true;
    primary.set("1-projects/inflight.md", { body: "INFLIGHT-EDIT", etag: "p9-edited" });
  };
  hooks.push(editDuringMove);
  const inflight = await callTool(env, TOKEN_OWNER, "move_note", {
    source: "1-projects/inflight.md",
    destination: "1-projects/inflight-moved.md",
  });
  hooks.splice(hooks.indexOf(editDuringMove), 1);
  check("an edit that lands mid-move is a conflict, not a silent overwrite", edited && inflight?.isError === true);
  check(
    "...and it is the editor's version that survives",
    primary.get("1-projects/inflight.md")?.body === "INFLIGHT-EDIT"
  );
  check(
    "...and the half-written destination is rolled back",
    (await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/inflight-moved.md",
    }))?.isError === true
  );

  /* --------------------- 3. neither conditional at all -------------------- */

  unsafe.set("1-projects/nope.md", { body: "NOPE-MARKER", etag: "u1" });
  const refused = await callTool(env, TOKEN_UNSAFE, "move_note", {
    source: "1-projects/nope.md",
    destination: "1-projects/nope-moved.md",
  });
  check(
    "a backend enforcing neither conditional is refused",
    refused?.isError === true && /conditional/i.test(textOf(refused))
  );
  check(
    "...and its note is left exactly where it was",
    unsafe.get("1-projects/nope.md")?.body === "NOPE-MARKER"
  );

  /* ----------------------- 4. across two workspaces ----------------------- */

  primary.set("1-projects/handover.md", { body: "HANDOVER-MARKER", etag: "p3" });
  const across = await callTool(env, TOKEN_OWNER, "move_note", {
    source: "1-projects/handover.md",
    destination: "1-projects/handover.md",
    source_context: "@r2like",
    destination_context: "@second",
  });
  check(
    "a cross-workspace move works with no conditional delete on either side",
    !across?.isError && /moved/i.test(textOf(across))
  );
  check(
    "...and the note is in the other workspace's bucket",
    second.get("1-projects/handover.md")?.body === "HANDOVER-MARKER"
  );
  check(
    "...and out of the first one",
    (await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/handover.md",
      context: "@r2like",
    }))?.isError === true
  );
  const handoverHead = collaborationHeads(primary).find(
    (head) => head.path === "1-projects/handover.md",
  );
  check(
    "...leaving a recoverable collaboration tombstone in the source workspace",
    handoverHead?.status === "deleted" && typeof handoverHead.documentId === "string"
  );
  check(
    "...whose identity still names the note it came from",
    handoverHead?.path === "1-projects/handover.md"
  );

  /* ------------------------ 4b. archive is a move too --------------------- */

  /*
    `archive_note` copies into the archive and deletes the source, which is a
    move — and its delete was unconditional long before any of this, so it had
    the hazard with none of the guard. These two checks are why it is in this
    suite rather than left for later: the fix is the same helper, and the
    behaviour to preserve is that a bucket which could always archive still can.
  */
  primary.set("1-projects/retiring.md", { body: "RETIRING-MARKER", etag: "pa1" });
  const archived = await callTool(env, TOKEN_OWNER, "archive_note", {
    path: "1-projects/retiring.md",
  });
  check("a note archives on a store with no conditional delete", !archived?.isError);
  const archivedPath = /→ (\S+)/.exec(textOf(archived))?.[1];
  const oldArchiveSource = await callTool(env, TOKEN_OWNER, "read_note", {
    path: "1-projects/retiring.md",
  });
  check(
    "...and the old source forwards to the archived identity",
    typeof archivedPath === "string" &&
      textOf(oldArchiveSource).includes(`path: ${archivedPath}`) &&
      textOf(oldArchiveSource).includes("moved_from: 1-projects/retiring.md"),
  );
  check(
    "...with the bytes under the archive this context declares",
    [...primary.keys()].some(
      (key) => key.startsWith("4-archive/") && primary.get(key)?.body === "RETIRING-MARKER"
    )
  );

  primary.set("1-projects/edited-while-archiving.md", { body: "ARCH-ORIGINAL", etag: "pa2" });
  let archiveEdited = false;
  const editDuringArchive = async (url, init = {}) => {
    if ((init.method || "GET").toUpperCase() !== "PUT") return;
    if (!url.includes("/move-r2like/4-archive/")) return;
    if (archiveEdited) return;
    archiveEdited = true;
    primary.set("1-projects/edited-while-archiving.md", {
      body: "ARCH-EDIT",
      etag: "pa2-edited",
    });
  };
  hooks.push(editDuringArchive);
  const archiveRaced = await callTool(env, TOKEN_OWNER, "archive_note", {
    path: "1-projects/edited-while-archiving.md",
  });
  hooks.splice(hooks.indexOf(editDuringArchive), 1);
  check(
    "an edit landing mid-archive is a conflict rather than a lost edit",
    archiveEdited && archiveRaced?.isError === true
  );
  check(
    "...and the editor's version is still there",
    primary.get("1-projects/edited-while-archiving.md")?.body === "ARCH-EDIT"
  );
  check(
    "...and the archive copy is rolled back rather than left as a stale twin",
    !(await callTool(env, TOKEN_OWNER, "list_notes", {
      prefix: "4-archive/",
    }))?.content?.[0]?.text?.includes("edited-while-archiving.md")
  );

  /* -------------------------- 5. thousands of them ------------------------ */

  const BULK = 1200;
  for (let n = 0; n < BULK; n += 1) {
    primary.set(`3-teams/big/note-${String(n).padStart(4, "0")}.md`, {
      body: `BULK-${n}`,
      etag: `b${n}`,
    });
  }
  const folder = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "3-teams/big",
    destination: "3-teams/moved",
  });
  const folderText = textOf(folder);
  check(
    "a folder of thousands cuts over logically instead of refusing",
    !folder?.isError && /logical move active/.test(folderText)
  );
  const moveId = /move_id: (\S+)/.exec(folderText)?.[1];
  check("...and names the move it can be resumed with", Boolean(moveId));

  // Bounded passes, exactly as an owner or the background worker would drive
  // them. The cap is generous relative to BULK / MOVE_MATERIALIZE_BATCH so a
  // regression shows up as "never finishes" rather than as a hang.
  let passes = 0;
  let last = "";
  while (passes < 60) {
    const pass = await callTool(env, TOKEN_OWNER, "materialize_move", { id: moveId });
    last = textOf(pass);
    passes += 1;
    if (pass?.isError || /complete|no active work/.test(last)) break;
  }
  check("...and materializes to completion in bounded batches", /complete/.test(last));
  check("...taking more than one pass, so the batching is real", passes > 1);

  const arrived = [...primary.keys()].filter((key) => key.startsWith("3-teams/moved/"));
  const listedSourceAfterBulk = textOf(
    await callTool(env, TOKEN_OWNER, "list_notes", { prefix: "3-teams/big/" }),
  );
  check(`...with all ${BULK} objects at the destination`, arrived.length === BULK);
  check("...and nothing left at the source prefix", !listedSourceAfterBulk.includes("note-"));
  check(
    "...and the bytes are the originals, not markers",
    primary.get("3-teams/moved/note-0000.md")?.body === "BULK-0" &&
      primary.get(`3-teams/moved/note-${String(BULK - 1).padStart(4, "0")}.md`)?.body ===
        `BULK-${BULK - 1}`
  );

  /* ---- 6. a stranger at the destination, wearing the source's etag ------- */

  /*
    THE ONE THING `canVerifyMoveByEtag` IS FOR.

    A materialization that resumes has to answer "is the destination already
    my content?", and `destinationMatchesMoveSource` answers it two ways: by
    comparing etags when the store does same-store copy, and by comparing
    bytes otherwise. A wrong `true` is not a cosmetic bug — it marks the pair
    copied without copying it, and the delete phase then REMOVES THE SOURCE.
    Adoption of a pre-existing destination happens through that function and
    nowhere else: the line after it throws `destination changed` for anything
    already sitting there.

    So the etag shortcut carries a premise — that this store's etag is derived
    from the content — and this binding declares `serverSideCopy: false`,
    which is exactly the case where the premise is not available and the byte
    comparison must be what decides.

    The fixture is the disagreement itself: a note at the destination with
    DIFFERENT bytes and the SAME etag the plan recorded for the source. Real
    S3 etags are the content MD5 for a single-part object, so this is not a
    collision anybody expects — but the ETag contract is opaque (multipart and
    SSE-KMS both break the MD5 rule), and a customer's own bucket is free to
    be either. The guard is what makes that somebody else's problem.

    Measured against `canVerifyMoveByEtag` forced to `true`: 0 before this
    check existed, because no fixture could produce the disagreement.
  */
  const COLLIDE_ETAG = "collide-same-etag";
  /*
    Big enough that materialization takes several passes, and the collision is
    on the LAST key so it is still pending when it is planted. 600 was the
    first attempt and it was wrong: the move finished inside `move_folder`, so
    the plant landed on an already-moved note and `materialize_move` answered
    "not found" — which an `isError` check read as the refusal under test. The
    refusal is asserted by its words now, not by its truthiness.
  */
  const COLLIDE = 1200;
  const LAST = String(COLLIDE - 1).padStart(4, "0");
  for (let n = 0; n < COLLIDE; n += 1) {
    primary.set(`3-teams/collide/note-${String(n).padStart(4, "0")}.md`, {
      body: `COLLIDE-${n}`,
      etag: n === COLLIDE - 1 ? COLLIDE_ETAG : `c${n}`,
    });
  }
  const collideMove = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "3-teams/collide",
    destination: "3-teams/collided",
  });
  const collideId = /move_id: (\S+)/.exec(textOf(collideMove))?.[1];
  check("the colliding folder cuts over logically too", Boolean(collideId));

  // Somebody else's note lands at the first destination key, carrying the etag
  // the plan recorded for the source. Only the bytes disagree.
  const COLLIDE_SOURCE = `3-teams/collide/note-${LAST}.md`;
  const COLLIDE_DESTINATION = `3-teams/collided/note-${LAST}.md`;
  primary.set(COLLIDE_DESTINATION, { body: "NOT MINE", etag: COLLIDE_ETAG });

  let collidePasses = 0;
  let collideLast = "";
  let collideRefused = false;
  while (collidePasses < 60) {
    const pass = await callTool(env, TOKEN_OWNER, "materialize_move", { id: collideId });
    collideLast = textOf(pass);
    collidePasses += 1;
    if (pass?.isError) {
      collideRefused = true;
      break;
    }
    if (/complete|no active work/.test(collideLast)) break;
  }
  check(
    "a destination whose etag matches but whose bytes differ is refused, not adopted",
    collideRefused && /destination changed/.test(collideLast),
  );
  check(
    "...so the source note is still there, with its own bytes",
    primary.get(COLLIDE_SOURCE)?.body === `COLLIDE-${COLLIDE - 1}`,
  );
  check(
    "...and the stranger's note was not overwritten either",
    primary.get(COLLIDE_DESTINATION)?.body === "NOT MINE",
  );

  restoreControlPlane();
  restoreS3();
}

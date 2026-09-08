/**
 * WORKSPACE-KEY ROTATION, ACROSS A PARTIAL WALK.
 *
 * `encryptionGateway.test.mjs` proves rotation on a small, already-busy
 * fixture — one call, two notes, done. This file asks the question that
 * matters at scale: what happens when the walk cannot finish in one call, and
 * what happens when it is interrupted and resumed.
 *
 * Three claims:
 *
 *  1. **The walk is resumable.** More encrypted notes than `ROTATION_BATCH_CAP`
 *     allows in one call: the first call re-wraps a bounded batch and reports
 *     "in progress"; a second call finishes the rest and reports "complete".
 *  2. **The walk is idempotent under sabotage.** A note whose write conflicts
 *     mid-pass (a stale etag — the same failure a genuine crash between the
 *     read and the write would leave behind) is left on its old generation
 *     rather than corrupted, and a later call picks it up and finishes it.
 *     Every note opens, throughout and at the end.
 *  3. **The retiring generation stays readable.** Both while the walk is in
 *     progress and after it reports complete, a note still wrapped under the
 *     OLD generation — including one this codebase never touches again, the
 *     way a restored or externally-synced note might be — still decrypts.
 *     Nothing is purged.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted. Count is FAIL lines in this file.
 *
 *   `toolRotateEncryptionKeys` counting a `put` conflict as done rather
 *   than pending                                                      2 → 4
 *
 * Added in adversarial review:
 *
 *   the batch-cap stop turned back into a `continue`, so one call reads
 *   the whole bucket instead of the batch it is allowed to move           2
 *   `rewrapWorkspaceRecipient` giving the body a fresh `iv` — a re-encrypt
 *   wearing a re-wrap's costume                                          10
 *
 * Added in a second adversarial review:
 *
 *   the completing call's read cost bounded to the batch cap instead of
 *   the bucket — the shape a persisted cursor would have, asserted so the
 *   ceiling is measured rather than estimated                             1
 *
 * The conflict row moved from 2 to 4 on re-measurement, and the two extra
 * failures are the two checks this review added around it: a walk that thinks
 * a lost write is a done write reports "complete" one call early, so the
 * completing call's read cost is measured on the wrong call and a note is
 * still left on the retired generation. The number in a sabotage record is
 * only true of the file it was measured on.
 *
 * Added when the walk grew a persisted cursor, replacing the whole-bucket
 * re-list this file used to measure above (see `docs/decisions/encryption.md`,
 * "Rotation", for the before/after table this removes the ceiling from):
 *
 *   the "behind the cursor" detection disabled (a note moved or created at a
 *   key the cursor already swept past is never re-examined)                2
 *   cursor persistence disabled (`loadRotationProgress` always starts
 *   fresh) — reintroduces the whole-bucket-per-call cost the cursor exists
 *   to remove, caught on the completing call's own bound                   1
 *   the never-destroy-notes guard removed (a note this call could not
 *   re-wrap is deleted instead of left exactly as it was)                  1
 *   a single stuck note halts the whole sweep instead of the cursor
 *   skipping past it via `stuckKeys` — reintroduces the same unbounded
 *   per-call cost as disabling persistence, just triggered by one bad note
 *   rather than by no cursor at all                                       5
 *
 * The last one is the one worth reading closely: it fails five different
 * checks at once, because a cursor that cannot get past a single stubborn
 * note is a cursor that has stopped bounding anything — every property this
 * file otherwise proves piecemeal (idempotence, the read-cost ceiling, the
 * behind-cursor catch-up) depends on that one line letting the walk move on.
 */

import worker from "../src/index.js";
import { isEncryptedNote, parseEncryptedNote } from "../src/encryption.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

export function makeBucket() {
  const objects = new Map();
  let etagCounter = 0;
  const encoder = new TextEncoder();
  return {
    objects,
    bucket: {
      async get(key) {
        if (!objects.has(key)) return null;
        const { bytes, etag } = objects.get(key);
        return {
          etag,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.slice().buffer,
        };
      },
      async put(key, value, options = {}) {
        const expected = options?.onlyIf?.etagMatches;
        if (expected && objects.get(key)?.etag !== expected) return null;
        const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
        const etag = `e${++etagCounter}`;
        // A real backend's listing reports a real last-modified time per
        // object, distinct from every other object's — that is the whole
        // thing `toolRotateEncryptionKeys`'s "behind the cursor" detection
        // reads for free off `list()`. Stamped at write time and carried
        // through, rather than `new Date()` at list time, which would make
        // every object look freshly written on every single listing and
        // defeat that detection entirely.
        objects.set(key, { bytes, etag, uploaded: new Date() });
        return { etag };
      },
      async delete(key) {
        objects.delete(key);
      },
      async list({ prefix } = {}) {
        const listed = [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          .map((key) => ({
            key,
            size: objects.get(key).bytes.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          }));
        return { objects: listed, truncated: false };
      },
    },
  };
}

export const PRIVACY = [
  "---",
  "role: privacy-manifest",
  "version: 1",
  "---",
  "",
  "<!-- BEGIN BRAIN PRIVACY RULES -->",
  "",
  "```yaml",
  "default_visibility: private",
  "",
  "folder_defaults:",
  "  1-projects: private",
  "",
  "note_overrides:",
  "```",
  "",
  "<!-- END BRAIN PRIVACY RULES -->",
  "",
].join("\n");

export const KEY_1 = "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=";

/** ROTATION_BATCH_CAP in `src/index.js`. Kept in sync by the assertion below. */
export const ROTATION_BATCH_CAP = 200;

export function noteBody(i) {
  return `---\nupdated: 2026-09-07\n---\n\n# note ${i}\n\nbody of note number ${i}.\n`;
}

export async function runEncryptionRotationChecks(check) {
  const a = makeBucket();
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();

  try {
    controlPlane.addWorkspace("ws_rot", "rot", {
      provider: "r2-binding",
      bindingName: "BUCKET_ROT",
      capabilities: { conditionalWrite: true },
      status: "active",
      encryptionKey: { current: "k1", keys: { k1: KEY_1 } },
    });
    const OWNER = "cat_test_rot_owner_00000000000000000";
    await controlPlane.addGrant({
      accessToken: OWNER,
      workspaceId: "ws_rot",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_rot_owner",
      userId: "user_rot_owner",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "BUCKET_ROT",
      BUCKET_ROT: a.bucket,
    };

    let id = 0;
    async function call(name, args = {}) {
      const res = await worker.fetch(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
        }),
        env,
        { waitUntil() {} },
      );
      return (await res.json()).result;
    }
    const textOf = (result) => result?.content?.[0]?.text ?? "";
    const readA = (key) => {
      const entry = a.objects.get(key);
      return entry ? new TextDecoder().decode(entry.bytes) : undefined;
    };

    await a.bucket.put("privacy.md", PRIVACY);

    // More encrypted notes than one call re-wraps. `set_encryption` per note
    // would be N tool round trips just to set up the fixture; writing the
    // encrypted form directly with the pure module keeps this file about the
    // walk, not about `set_encryption`, and matches what the note actually
    // looks like in the bucket either way.
    const { encryptNote } = await import("../src/encryption.js");
    const noteCount = ROTATION_BATCH_CAP + 5;
    for (let i = 0; i < noteCount; i += 1) {
      const path = `1-projects/note-${String(i).padStart(4, "0")}.md`;
      const stored = await encryptNote(noteBody(i), {
        workspaceId: "ws_rot",
        workspaceKey: KEY_1,
        keyId: "k1",
      });
      await a.bucket.put(path, stored);
    }

    /* -- (1) the walk is resumable ------------------------------------------ */

    /*
      THE BODY CIPHERTEXT OF EVERY NOTE, BEFORE ANY OF THIS.

      "Rotation re-wraps note keys and never re-encrypts bodies" is the claim
      the whole per-note-key design exists to make true, and it is a claim
      about all of them: one note's `ct` matching proves the code path taken
      for one note, and a rotation that re-encrypted every *other* note would
      pass that. Compared over the whole bucket after the walk finishes.
    */
    const ciphertextBefore = new Map();
    for (const key of [...a.objects.keys()].filter((k) => k.startsWith("1-projects/"))) {
      const envelope = parseEncryptedNote(readA(key));
      ciphertextBefore.set(key, `${envelope.ct}|${envelope.iv}|${envelope.aad}`);
    }

    /*
      AND WHAT ONE CALL READS.

      The walk's own progress is persisted in the bucket
      (`ROTATION_PROGRESS_PATH`), as a cursor, so a call resumes from where the
      last one left off rather than re-listing and re-reading everything
      before it. Its cost is one extra read for the progress file, plus
      (roughly) one object read per note this call actually examines — the
      batch it moves, not the notes some earlier call already confirmed clean.
      See "Rotation" in `docs/decisions/encryption.md` for the measured curve
      this replaces.
    */
    const realGet = a.bucket.get.bind(a.bucket);
    let getsDuringFirstCall = 0;
    a.bucket.get = async (key) => {
      getsDuringFirstCall += 1;
      return realGet(key);
    };
    const first = await call("rotate_encryption_keys", {});
    a.bucket.get = realGet;
    check(
      "one call reads about as many objects as it re-wraps, not as many as the bucket holds",
      getsDuringFirstCall <= ROTATION_BATCH_CAP + 5 && getsDuringFirstCall >= ROTATION_BATCH_CAP,
    );
    check(
      "the first call re-wraps a bounded batch and reports it is not done",
      !first?.isError &&
        /rotation in progress: k1 → k2/.test(textOf(first)) &&
        new RegExp(`${ROTATION_BATCH_CAP} note\\(s\\) re-wrapped`).test(textOf(first)) &&
        /*
          TWO DIFFERENT FACTS, AND THE SENTENCE KEEPS THEM APART.

          "at least N left" is a census of what this call actually read and
          could not move — exact, and zero here. Whether anything remains
          past the frontier is a separate clause, because the per-call budget
          counts object READS rather than notes moved: a call can spend all of
          it on notes that turn out to be clean, so "the batch is spent"
          cannot be reported as "a note is left". What must stay true is that
          it never says the walk is done while notes remain, which the next
          check asks of the bucket rather than of the sentence.
        */
        /at least 0 left on k1, and the bucket is not swept to the end yet/.test(textOf(first)),
    );

    const onK1AfterFirst = [...a.objects.keys()].filter(
      (key) => key.startsWith("1-projects/") && readA(key).includes("context_encryption_key: ws:k1"),
    );
    const onK2AfterFirst = [...a.objects.keys()].filter(
      (key) => key.startsWith("1-projects/") && readA(key).includes("context_encryption_key: ws:k2"),
    );
    check(
      "exactly the batch cap moved this call, and the rest are untouched",
      onK1AfterFirst.length === 5 && onK2AfterFirst.length === ROTATION_BATCH_CAP,
    );

    // While a walk is in progress, EVERY note still opens — the ones already
    // moved, through the new generation, and the ones not yet moved, through
    // the old one, which is exactly what "the retiring generation stays
    // readable until the walk completes" has to mean in practice.
    const stillOnK1 = onK1AfterFirst[0];
    const alreadyOnK2 = onK2AfterFirst[0];
    const readStillOnK1 = await call("read_note", { path: stillOnK1 });
    const readAlreadyOnK2 = await call("read_note", { path: alreadyOnK2 });
    check(
      "a note not yet reached by the walk still opens, through the old generation",
      !readStillOnK1?.isError,
    );
    check(
      "a note the walk already moved opens too, through the new one",
      !readAlreadyOnK2?.isError,
    );

    /* -- (2) sabotage: a conflicting write mid-pass is left, not corrupted -- */

    // Force exactly one conditional `put` to fail, for exactly one key, the
    // way a genuinely concurrent write between this walk's read and its own
    // write would — no etag trick needed, because a real race is exactly
    // "the write this code issues loses", and that is what this reproduces
    // directly rather than by trying to win a timing race against itself.
    // `toolRotateEncryptionKeys` must count this as still pending, not as
    // done, and must not corrupt the note by writing over it some other way.
    const sabotaged = stillOnK1;
    const beforeSabotage = readA(sabotaged);
    const realPut = a.bucket.put.bind(a.bucket);
    let sabotageArmed = true;
    a.bucket.put = async (key, value, options) => {
      if (sabotageArmed && key === sabotaged) {
        sabotageArmed = false;
        return null; // the shape a conditional-write conflict returns
      }
      return realPut(key, value, options);
    };

    /* -- (3) resume: the second call hits the sabotaged write, third finishes */

    const second = await call("rotate_encryption_keys", {});
    check(
      "the sabotaged write is counted as still pending, not as done, and the walk is not corrupted",
      !second?.isError &&
        /rotation in progress: k1 → k2/.test(textOf(second)) &&
        /at least 1 left/.test(textOf(second)) &&
        readA(sabotaged) === beforeSabotage, // untouched — the failed write changed nothing
    );
    check(
      "the sabotaged note still names the old generation and still opens",
      readA(sabotaged).includes("context_encryption_key: ws:k1") &&
        !(await call("read_note", { path: sabotaged }))?.isError,
    );

    // The property a stuck note must never cost: the FOUR notes that sort
    // AFTER it were still rewrapped in this SAME call. A cursor that refused
    // to advance past a note it could not move would pin every call after
    // this one at that exact position, re-walking everything past it from
    // scratch forever — the same unbounded cost this design exists to
    // remove, just moved one note earlier. `stuckKeys` is what lets the
    // cursor move past it instead.
    const onK2AfterSecond = [...a.objects.keys()].filter(
      (key) => key.startsWith("1-projects/") && readA(key).includes("context_encryption_key: ws:k2"),
    );
    check(
      "notes sorting after the stuck one still moved this same call — the cursor did not stall on it",
      onK2AfterSecond.length === ROTATION_BATCH_CAP + 4,
    );

    /*
      WHAT THE CALL THAT *COMPLETES* A ROTATION COSTS, MEASURED.

      With a persisted cursor, the completing call resumes from where the
      cursor already reached rather than re-listing and re-reading every note
      in the bucket to prove none are left. Its cost is: one read for the
      progress file, one retry per note still in `stuckKeys` (here: the one
      note the sabotage above left behind), plus whatever is left in the
      cursor's own forward and behind-cursor sweeps — a small, roughly
      constant number, not one read per note in the bucket. See the measured
      before/after table in `docs/decisions/encryption.md` for the curve this
      replaces (the "before" column is what this exact scenario cost prior to
      the persisted cursor: reads scaling with `noteCount`).

      Asserted here so the new bound is a measured number in the suite rather
      than an estimate in prose, and so the day somebody reintroduces a full
      re-scan on the completing call this check fails and says why.
    */
    let readsDuringCompletingCall = 0;
    // The exact reference, put back exactly — the `put` wrapper armed above is
    // deliberately left in place, because by this call its one shot is spent
    // and swapping it out here would be tidying up somebody else's fixture.
    const getBeforeCounting = a.bucket.get;
    a.bucket.get = async (key) => {
      readsDuringCompletingCall += 1;
      return getBeforeCounting.call(a.bucket, key);
    };
    const third = await call("rotate_encryption_keys", {});
    a.bucket.get = getBeforeCounting;
    check(
      "a further call finishes the one note the sabotage left behind",
      !third?.isError && /rotation complete: k1 → k2/.test(textOf(third)),
    );
    check(
      "the call that COMPLETES a rotation reads a small, roughly constant number of objects, " +
        "not one per note in the bucket — the ceiling the persisted cursor removes",
      readsDuringCompletingCall <= 5,
    );

    const remainingOnK1 = [...a.objects.keys()].filter(
      (key) => key.startsWith("1-projects/") && readA(key).includes("context_encryption_key: ws:k1"),
    );
    check("no note is left on the retired generation once the walk reports complete", remainingOnK1.length === 0);

    // Every single note opens at the end, sabotaged one included — the
    // property that matters more than any intermediate count.
    let allOpen = true;
    for (let i = 0; i < noteCount; i += 1) {
      const path = `1-projects/note-${String(i).padStart(4, "0")}.md`;
      const read = await call("read_note", { path });
      if (read?.isError || !textOf(read).includes(`# note ${i}`)) {
        allOpen = false;
        break;
      }
    }
    check("every one of the notes still opens to exactly its plaintext after the full rotation", allOpen);

    // And not one body was re-encrypted on the way. Same `ct`, same `iv`, same
    // `aad`, for every note in the bucket — only the recipient's `wrapped` and
    // the frontmatter marker moved.
    let bodiesUntouched = ciphertextBefore.size === noteCount;
    for (const [key, before] of ciphertextBefore) {
      const envelope = parseEncryptedNote(readA(key));
      if (`${envelope.ct}|${envelope.iv}|${envelope.aad}` !== before) {
        bodiesUntouched = false;
        break;
      }
    }
    check(
      "not one note's body ciphertext changed across the whole rotation",
      bodiesUntouched,
    );

    /* -- (4) the retired generation is not purged, and still opens ---------- */
    //
    // No automatic purge exists in this codebase — see "Rotation" in
    // docs/decisions/encryption.md. This proves the consequence rather than
    // the absence of code: a note that somehow still names the retired
    // generation (an old bucket-versioning restore, a client that synced the
    // pre-rotation ciphertext straight into the bucket) opens exactly as it
    // did before the rotation, with no separate action taken.
    const strayOnRetiredGeneration = await encryptNote(noteBody("stray"), {
      workspaceId: "ws_rot",
      workspaceKey: KEY_1,
      keyId: "k1",
    });
    await a.bucket.put("1-projects/stray-restored-note.md", strayOnRetiredGeneration);
    const strayRead = await call("read_note", { path: "1-projects/stray-restored-note.md" });
    check(
      "a note that reappears wrapped under the now-retired generation still opens",
      !strayRead?.isError && textOf(strayRead).includes("# note stray"),
    );

    /* -- (5) a note added or moved BEHIND the cursor is not skipped --------- */
    //
    // The cursor sweeps the bucket in key order. A note that lands at an
    // earlier key — moved in from elsewhere, or freshly created — after the
    // cursor has already passed that position is exactly the case a
    // positional cursor alone would miss forever. `toolRotateEncryptionKeys`
    // catches it using `uploaded`, which every listing already reports at no
    // extra cost: a key at or before the cursor whose upload time is after
    // the current pass began is re-examined regardless of position.
    //
    // A second, brand-new rotation (k2 -> k3) exercises this on the same
    // bucket the first rotation left on k2 — 205 notes on k2, one stray still
    // on the long-retired k1 (untouched by this rotation too, same as ever).
    const exportedForK2 = await call("export_encryption_keys", {});
    const exportedDoc = JSON.parse(textOf(exportedForK2).slice(textOf(exportedForK2).indexOf("{")));
    const K2_MATERIAL = exportedDoc.keys.find((entry) => entry.generation === "k2")?.key;
    check("the export carries k2's own material to build the fixture below", typeof K2_MATERIAL === "string");

    const secondRotationFirstCall = await call("rotate_encryption_keys", {});
    check(
      "a fresh rotation starts (k2 -> k3) and moves a bounded batch, exactly like the first one did",
      !secondRotationFirstCall?.isError &&
        /rotation in progress: k2 → k3/.test(textOf(secondRotationFirstCall)) &&
        new RegExp(`${ROTATION_BATCH_CAP} note\\(s\\) re-wrapped`).test(textOf(secondRotationFirstCall)),
    );

    // A note lands at a key that sorts BEFORE every "1-projects/..." key the
    // cursor has already swept past this pass — the shape of a move into an
    // earlier folder while a rotation is under way. Wrapped under k2, the
    // CURRENT-at-the-time generation, exactly as a real move would leave it:
    // a move never touches the envelope, so its generation is whatever it
    // already was.
    const movedInBehindCursor = await encryptNote(noteBody("moved-in"), {
      workspaceId: "ws_rot",
      workspaceKey: K2_MATERIAL,
      keyId: "k2",
    });
    await a.bucket.put("0-inbox/moved-in-behind-cursor.md", movedInBehindCursor);

    let secondRotationDone = false;
    for (let i = 0; i < 10 && !secondRotationDone; i += 1) {
      const res = await call("rotate_encryption_keys", {});
      if (/rotation complete: k2 → k3/.test(textOf(res))) secondRotationDone = true;
    }
    check("the second rotation still completes with a note added behind the cursor mid-walk", secondRotationDone);

    const movedInRead = await call("read_note", { path: "0-inbox/moved-in-behind-cursor.md" });
    check(
      "the note added behind the cursor opens, and now names the new generation — it was not skipped",
      !movedInRead?.isError &&
        textOf(movedInRead).includes("# note moved-in") &&
        readA("0-inbox/moved-in-behind-cursor.md").includes("context_encryption_key: ws:k3"),
    );

    // And the same census as before, restated for the second rotation: no
    // note anywhere in the bucket still names k2 once this reports complete,
    // and the k1-wrapped stray from section (4) is exactly as untouched as it
    // was — a rotation only ever targets its own outgoing generation.
    const anyOnK2 = [...a.objects.keys()].some((key) => {
      if (isPlumbingPath(key) || !key.endsWith(".md")) return false;
      const text = readA(key);
      return text.includes("context_encryption_key: ws:k2");
    });
    check("no note anywhere in the bucket still names k2 once the second rotation reports complete", !anyOnK2);
    check(
      "the k1-wrapped stray from the first rotation's grace-period check is still exactly on k1",
      readA("1-projects/stray-restored-note.md").includes("context_encryption_key: ws:k1"),
    );
  } finally {
    restore();
  }
}

/** Mirrors `isPlumbing` in `src/index.js` closely enough for this file's own bucket census. */
export function isPlumbingPath(key) {
  return key.split("/").some((segment) => segment.startsWith("."));
}

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
 *   than pending                                                          2
 *
 * Added in adversarial review:
 *
 *   the batch-cap stop turned back into a `continue`, so one call reads
 *   the whole bucket instead of the batch it is allowed to move           2
 *   `rewrapWorkspaceRecipient` giving the body a fresh `iv` — a re-encrypt
 *   wearing a re-wrap's costume                                          10
 */

import worker from "../src/index.js";
import { isEncryptedNote, parseEncryptedNote } from "../src/encryption.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

function makeBucket() {
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
        objects.set(key, { bytes, etag });
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
            uploaded: new Date(),
            etag: objects.get(key).etag,
          }));
        return { objects: listed, truncated: false };
      },
    },
  };
}

const PRIVACY = [
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

const KEY_1 = "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=";

/** ROTATION_BATCH_CAP in `src/index.js`. Kept in sync by the assertion below. */
const ROTATION_BATCH_CAP = 200;

function noteBody(i) {
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

      There is no persisted cursor: the walk re-lists the bucket every call.
      That is a deliberate trade (see "Rotation" in
      `docs/decisions/encryption.md`), and its cost is one object read per note
      *examined* — which is why the walk stops at the first note it finds still
      pending once its batch is spent, rather than reading to the end of the
      bucket to count the remainder. Without that stop this call read 601
      objects over a 600-note bucket to move 200 of them; a Worker invocation
      has a subrequest budget and a bucket has no upper bound, so the cost of
      one call may not scale with the size of the bucket.
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
        // A FLOOR, not a census. The walk stops at the first note it finds
        // still on the outgoing generation once its batch is spent, rather
        // than reading the rest of the bucket to count them — see the
        // `ROTATION_BATCH_CAP` break in `toolRotateEncryptionKeys`. What must
        // stay true is that it never reports zero left while notes remain,
        // which the next check asks of the bucket rather than of the sentence.
        /at least 1 left/.test(textOf(first)),
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

    const third = await call("rotate_encryption_keys", {});
    check(
      "a further call finishes the one note the sabotage left behind",
      !third?.isError && /rotation complete: k1 → k2/.test(textOf(third)),
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
  } finally {
    restore();
  }
}

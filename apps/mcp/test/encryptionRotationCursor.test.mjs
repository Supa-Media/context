/**
 * WHAT THE PERSISTED CURSOR MADE POSSIBLE, ASKED ADVERSARIALLY.
 *
 * `encryptionRotation.test.mjs` drives the walk the way a caller does. This
 * file asks the four questions a persisted cursor introduces that a
 * cursor-less walk could not be asked — each one measured *failing* on the
 * first version of the change that introduced the cursor, on the branch that
 * became this one:
 *
 *  1. **A note that moves behind the cursor WHILE a call is running.** That
 *     call's listing was taken before the move, so it cannot see it; the next
 *     call sees it only if the boundary it compares `uploaded` against is
 *     older than that listing. Taking the boundary at the *end* of the call
 *     instead — after its own writes, to save re-reading them — left the note
 *     on the outgoing generation and retired the generation anyway. Measured:
 *     `generation=k1`, `rotation complete`.
 *  2. **Second-granularity `uploaded`.** S3's `ListObjectsV2` and Dropbox's
 *     `server_modified` report whole seconds. Comparing a millisecond
 *     boundary against a truncated timestamp lost a note moved behind the
 *     cursor in four of eight runs, and retired the generation each time.
 *  3. **A progress file somebody else wrote.** A `cursor` sorting after every
 *     key, in an otherwise well-formed file, made the walk report complete
 *     having read no note at all — every note still wrapped under the
 *     outgoing generation, and that generation retired. `docs/decisions/encryption.md`
 *     then tells an operator it is safe to delete a retired generation's row
 *     once nothing names it, and that is the step at which those notes stop
 *     opening for good. A leaked bucket credential is the threat that file's
 *     own table calls "the one that matters", and a cursor is the first thing
 *     it has ever been able to write that the remediation reads back.
 *  4. **A budget that counts re-wraps rather than reads.** A bucket whose
 *     notes are mostly NOT encrypted — the ordinary shape of a workspace with
 *     encryption on for one folder — was passed over for free: 4,002 object
 *     reads in a single call over a 4,000-note bucket, and 10,002 over a
 *     10,000-note one. That is the exact ceiling the cursor exists to remove,
 *     moved from the last call to the first.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Count is FAIL lines in this file.
 *
 *   the boundary taken at the end of the call instead of before its listing  2
 *   `uploadedBefore` comparing raw milliseconds instead of whole seconds     1
 *   the progress file's authentication tag not checked on load               2
 *   the read budget counting re-wraps instead of reads                       1
 *   `wrote` not carried, so the catch-up re-reads the walk's own output      1
 */

import worker from "../src/index.js";
import { encryptNote } from "../src/encryption.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import {
  KEY_1,
  PRIVACY,
  ROTATION_BATCH_CAP,
  isPlumbingPath,
  makeBucket,
  noteBody,
} from "./encryptionRotation.test.mjs";

const PROGRESS_PATH = ".context/rotation-progress.json";
const textOf = (result) => result?.content?.[0]?.text ?? "";
const generationOf = (text) => (/context_encryption_key: ws:(\w+)/.exec(text || "") || [])[1];

/** One workspace, one bucket, one owner — a fresh fixture per scenario. */
async function fixture(id) {
  const a = makeBucket();
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  controlPlane.addWorkspace(`ws_${id}`, id, {
    provider: "r2-binding",
    bindingName: "BUCKET_ADV",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
    encryptionKey: { current: "k1", keys: { k1: KEY_1 } },
  });
  const OWNER = `cat_test_${id}_owner_0000000000000000000`;
  await controlPlane.addGrant({
    accessToken: OWNER,
    workspaceId: `ws_${id}`,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: `mcp_client_${id}`,
    userId: `user_${id}`,
  });
  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "BUCKET_ADV",
    BUCKET_ADV: a.bucket,
  };
  let seq = 0;
  const call = async (name, args = {}) => {
    const res = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      }),
      env,
      { waitUntil() {} },
    );
    return (await res.json()).result;
  };
  const read = (key) => {
    const entry = a.objects.get(key);
    return entry ? new TextDecoder().decode(entry.bytes) : undefined;
  };
  await a.bucket.put("privacy.md", PRIVACY);
  return { a, call, read, restore, workspaceId: `ws_${id}` };
}

/*
  A REAL BUCKET'S NOTES WERE NOT ALL WRITTEN IN THE SECOND THE ROTATION
  STARTED. Leaving a fixture's uploads stamped at `now` makes every note in it
  look like it arrived mid-walk, which measures the catch-up sweep rather than
  the walk, and is a cost no real rotation pays.
*/
function backdate(a, ms = 60_000) {
  for (const entry of a.objects.values()) entry.uploaded = new Date(Date.now() - ms);
}

async function seed(f, count, { encrypted = () => true } = {}) {
  for (let i = 0; i < count; i += 1) {
    const path = `1-projects/adv-${String(i).padStart(5, "0")}.md`;
    await f.a.bucket.put(
      path,
      encrypted(i)
        ? await encryptNote(noteBody(i), { workspaceId: f.workspaceId, workspaceKey: KEY_1, keyId: "k1" })
        : noteBody(i),
    );
  }
  backdate(f.a);
}

/*
  Driven the way a caller drives it: call again until it says complete, with
  no wait in between. Deliberately NOT aging the bucket between calls — a
  scenario here injects a note mid-call and then asks whether the walk finds
  it, and moving every object's timestamp backwards afterwards would move that
  note out of the window under test and prove nothing.
*/
async function driveToCompletion(f, limit = 40) {
  for (let i = 0; i < limit; i += 1) {
    const result = await f.call("rotate_encryption_keys", {});
    if (/rotation complete/.test(textOf(result))) return true;
  }
  return false;
}

export async function runRotationCursorAdversarialChecks(check) {
  /* -- (1) a note that moves behind the cursor WHILE a call is running ----- */
  {
    const f = await fixture("advmove");
    try {
      await seed(f, ROTATION_BATCH_CAP + 5);
      // The move lands immediately after the listing this call will work
      // from — the window a `move_note` racing the walk actually falls in,
      // and the one a boundary taken at the end of the call cannot cover.
      const realList = f.a.bucket.list.bind(f.a.bucket);
      let moved = false;
      f.a.bucket.list = async (options) => {
        const page = await realList(options);
        if (!moved) {
          moved = true;
          const from = `1-projects/adv-${String(ROTATION_BATCH_CAP + 4).padStart(5, "0")}.md`;
          const entry = f.a.objects.get(from);
          f.a.objects.delete(from);
          f.a.objects.set("0-inbox/raced-behind-the-cursor.md", { ...entry, uploaded: new Date() });
          /*
            AND THE REST OF THIS CALL TAKES A SECOND, THE WAY A REAL ONE DOES.

            A call that re-wraps two hundred notes over the network is not
            instantaneous, and the whole question here is which side of that
            span the boundary is taken on. Without the wait the in-memory
            stub finishes inside a single second, an end-of-call boundary
            lands in the same second as the move, and the whole-second
            comparison this code deliberately uses rescues the wrong design
            by accident — the check would pass against the bug it exists to
            catch. One second of suite time buys a guard that actually holds.
          */
          await new Promise((resolve) => setTimeout(resolve, 1_100));
        }
        return page;
      };
      const done = await driveToCompletion(f);
      f.a.bucket.list = realList;
      check(
        "a note moved behind the cursor WHILE a call was running is still re-wrapped, and the walk still completes",
        done && generationOf(f.read("0-inbox/raced-behind-the-cursor.md")) === "k2",
      );
      const left = [...f.a.objects.keys()].filter(
        (key) => key.endsWith(".md") && !isPlumbingPath(key) && generationOf(f.read(key)) === "k1",
      );
      check("...and nothing anywhere in the bucket is left on the retired generation", left.length === 0);
      const opened = await f.call("read_note", { path: "0-inbox/raced-behind-the-cursor.md" });
      check("...and it opens to its plaintext", !opened?.isError && textOf(opened).includes("# note"));
    } finally {
      f.restore();
    }
  }

  /* -- (2) the same, on a backend that reports whole seconds --------------- */
  {
    const f = await fixture("advsec");
    try {
      // S3's `LastModified` and Dropbox's `server_modified` carry seconds.
      const realPut = f.a.bucket.put.bind(f.a.bucket);
      f.a.bucket.put = async (key, value, options) => {
        const result = await realPut(key, value, options);
        const entry = f.a.objects.get(key);
        if (entry) entry.uploaded = new Date(Math.floor(entry.uploaded.getTime() / 1000) * 1000);
        return result;
      };
      await seed(f, ROTATION_BATCH_CAP + 5);
      await f.call("rotate_encryption_keys", {});
      const from = `1-projects/adv-${String(ROTATION_BATCH_CAP + 3).padStart(5, "0")}.md`;
      const entry = f.a.objects.get(from);
      f.a.objects.delete(from);
      f.a.objects.set("0-inbox/second-granularity.md", {
        ...entry,
        uploaded: new Date(Math.floor(Date.now() / 1000) * 1000),
      });
      const done = await driveToCompletion(f);
      check(
        "on a backend whose listing carries only whole seconds, a note moved behind the cursor " +
          "inside the boundary's own second is still re-wrapped",
        done && generationOf(f.read("0-inbox/second-granularity.md")) === "k2",
      );
    } finally {
      f.restore();
    }
  }

  /* -- (3) a progress file this gateway did not write --------------------- */
  {
    const f = await fixture("advforge");
    try {
      await seed(f, 8);
      /*
        THE FORGERY, WRITTEN THE WAY A LEAKED BUCKET CREDENTIAL WOULD.

        Well-formed, naming the live generation pair, and claiming a cursor
        that sorts after every key in the bucket. Nothing about its shape is
        wrong; the only thing wrong with it is that this gateway did not write
        it. Unauthenticated, the walk read no note, reported complete, and
        retired k1 with all eight notes still wrapped under it.
      */
      await f.a.bucket.put(
        PROGRESS_PATH,
        JSON.stringify({
          fromGeneration: "k1",
          toGeneration: "k2",
          cursor: `zzzz${String.fromCharCode(0xff)}`,
          confirmedThrough: Date.now() + 600_000,
          stuckKeys: [],
          wrote: [],
          mac: "not-the-tag-this-gateway-would-have-written",
        }),
      );
      const first = await f.call("rotate_encryption_keys", {});
      const leftAfterForgery = [...f.a.objects.keys()].filter(
        (key) => key.startsWith("1-projects/") && generationOf(f.read(key)) === "k1",
      );
      check(
        "a progress file this gateway did not sign cannot make the walk skip the bucket — " +
          "it re-wraps for real instead of completing on somebody else's cursor",
        !/rotation complete/.test(textOf(first)) || leftAfterForgery.length === 0,
      );
      check("...and the forged resume point leaves nothing on the retired generation", leftAfterForgery.length === 0);
      const progress = f.read(PROGRESS_PATH);
      check(
        "...and the progress file this gateway does write carries an authentication tag",
        progress === undefined || typeof JSON.parse(progress).mac === "string",
      );
      // A note still opens either way, which is the property that outranks
      // every count in this file.
      const opened = await f.call("read_note", { path: "1-projects/adv-00000.md" });
      check("...and every note still opens throughout", !opened?.isError && textOf(opened).includes("# note 0"));
    } finally {
      f.restore();
    }
  }

  /* -- (4) the budget counts reads, not re-wraps -------------------------- */
  {
    const f = await fixture("advmixed");
    try {
      // Ten times the batch cap, with the encrypted notes sorted LAST, so a
      // budget that counts only what it moves reads every plaintext note in
      // the bucket for free on its way to them.
      const total = ROTATION_BATCH_CAP * 10;
      await seed(f, total, { encrypted: (i) => i >= total - ROTATION_BATCH_CAP });
      const realGet = f.a.bucket.get.bind(f.a.bucket);
      let reads = 0;
      f.a.bucket.get = async (key) => {
        reads += 1;
        return realGet(key);
      };
      await f.call("rotate_encryption_keys", {});
      f.a.bucket.get = realGet;
      check(
        "a bucket whose notes are mostly NOT encrypted still bounds one call to about the batch " +
          "cap — the budget counts object reads, which is the quantity a subrequest budget counts",
        reads <= ROTATION_BATCH_CAP + 5,
      );
      check(
        "...measured on a bucket ten times the cap, so the bound is not the bucket",
        total === ROTATION_BATCH_CAP * 10,
      );
      // And it still finishes, having actually moved every encrypted note.
      const done = await driveToCompletion(f);
      const left = [...f.a.objects.keys()].filter(
        (key) => key.endsWith(".md") && !isPlumbingPath(key) && generationOf(f.read(key)) === "k1",
      );
      check("...and the walk still completes with nothing left on the outgoing generation", done && left.length === 0);
    } finally {
      f.restore();
    }
  }
}

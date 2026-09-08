/**
 * ENCRYPTION THROUGH THE GATEWAY — the read path, the write path, the tool, and
 * everything that must not touch a ciphertext on its way past.
 *
 * `encryption.test.mjs` proves the envelope in isolation. This file stands up a
 * real worker over two in-memory buckets and two workspaces holding two
 * different keys, because the properties that matter here are not properties of
 * AES-GCM — they are properties of the twelve places in this gateway that read
 * or rewrite a note body.
 *
 * The seven claims, and why each has to be asked here rather than upstream:
 *
 * 1. **Encryption is orthogonal to visibility.** A team-tier caller on a
 *    *private* encrypted note gets the byte-identical refusal it gets for a
 *    path that never existed — so encrypting a note adds no inference channel.
 *    A team-tier caller on a *team* encrypted note gets the plaintext, because
 *    the key belongs to the workspace and not to the owner. Both halves, or the
 *    first one passes for a gateway that simply refuses everything.
 * 2. **A workspace's key never opens another workspace's note.** The same
 *    ciphertext, byte for byte, in the other tenant's bucket, read by that
 *    tenant's owner: refused.
 * 3. **A round trip is not a downgrade.** Whether a write is encrypted is
 *    decided by the stored object; a client that read plaintext and echoed it
 *    back stores ciphertext, and one that posts an envelope-shaped body stores
 *    that as *content*, encrypted, rather than as a raw envelope.
 * 4. **A move does not touch the bytes.** Byte-for-byte equality across
 *    `move_note`, which is what binding the AAD to the workspace and not the
 *    path buys.
 * 5. **A link rewrite does not touch them either**, and the neighbours it does
 *    rewrite still get rewritten — a skip that skipped everything would pass
 *    half of this.
 * 6. **Search never quotes one.** Not through `search_notes`, not through the
 *    ChatGPT `fetch` dialect, and not into the index: `indexableText` is what
 *    both index paths call, and it is asserted directly as well as through the
 *    tools, because the projection is exercised by `searchProjection.test.mjs`
 *    and not by a bucket this file can see.
 * 7. **No key is a locked note, never a lost one.** A context whose key did not
 *    arrive can still read its plaintext notes, is refused its encrypted ones
 *    with an error that says what they are, and — the one that matters — cannot
 *    overwrite an encrypted note with plaintext.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   `toolWriteNote` writing `content` instead of `body`                     12
 *   `toolReadNote` returning the stored bytes rather than the plaintext      5
 *   `openStoredNote` handing back the bytes when it cannot decrypt           4
 *   `toolSetEncryption`'s `scope !== "private"` gate removed                 3
 *   `scanVisibleNotes` dropping its `isEncryptedNote` skip              0 → 1
 *   `indexableText` returning its argument unchanged                         1
 *   `rewriteReferences` dropping its `isEncryptedNote` skip                  0
 *
 * Added in adversarial review, with their own counts:
 *
 *   `export_encryption_keys`/`rotate_encryption_keys` left out of
 *   `PRIVATE_TIER_ONLY_TOOLS`, so `tools/list` advertises them to a
 *   team-tier connection the call then tells they do not exist              1
 *   `toolExportEncryptionKeys`'s `scope !== "private"` gate removed     3 → 4
 *   `EXPORT_RATE_LIMIT.limit` moved from 5 to 1                             2
 *   the export document written to a `console.log`                          1
 *   the audit detail carrying `Object.values(key.keys)` (the material
 *   itself) instead of its generation ids                                   2
 *
 * Added in a second adversarial review, re-measured on the same denominator:
 *
 *   `toolExportEncryptionKeys` taking `args` and reading a workspace id
 *   out of it — the smuggled-argument attack                                1
 *   `toolRotateEncryptionKeys` doing the same                               1
 *
 * The export-gate row moved from 3 to 4 because of a check added here, not
 * because the gate got stronger: with the gate gone, the team-tier caller's
 * earlier attempt succeeds and spends one of the five exports the window
 * allows, so the exact-count rate-limit check fails too. Re-measured rather
 * than left at the number it had when it was written.
 *
 * Three of the original rows are findings about this file rather than about
 * the source.
 *
 * **The scan skip measured zero**, because the only search in the file used a
 * needle out of the note's plaintext, which no envelope contains — so the scan
 * could not have matched an encrypted note whether it skipped one or not. The
 * fix is ordering as much as content: the first search now runs before anything
 * has built an index, so it falls to the literal scan, and it looks for
 * `A256GCM` — a string in every envelope and in nobody's note.
 *
 * **The link-rewrite skip measures zero and is left at zero, with a check
 * beside it instead of a manufactured number.** An envelope contains nothing a
 * link parser can match: `ct` is base64url, whose alphabet has no brackets, and
 * the JSON around it has no `[[` and no `](`. So deleting the guard changes
 * nothing today. `an envelope carries nothing a link rewriter could match` is
 * what keeps that true — the day the format grows a field that can carry a
 * bracket, that check fails, and the guard is what stops a rewrite corrupting a
 * note nothing can recover.
 *
 * **`indexableText` is one**, and it is asserted directly rather than through a
 * tool, because its two callers are the R2 shard sync and the D1 projection and
 * neither runs against a bucket this file owns. Reaching them means an
 * encrypted fixture in `searchProjection.test.mjs`, which is a larger change to
 * a suite that is not about this. One honest check beats a wider number bought
 * by testing something else.
 */

import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import {
  FENCE_LANGUAGE,
  indexableText,
  isEncryptedNote,
  parseEncryptedNote,
} from "../src/encryption.js";
import { parseLinks } from "../src/links.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The pinned passphrase-locked note, shared with `encryptionPassphrase.test.mjs`.
 *
 * One fixture, two suites: that file proves the bytes open with the right key,
 * this one proves the gateway cannot open them and cannot destroy them either.
 */
const PASSPHRASE_VECTOR = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./encryptionPassphraseVector.fixtures.json", import.meta.url)),
    "utf8",
  ),
);

/** A bucket stub with the same shape `test.mjs`'s has, and no more. */
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
        const bytes =
          typeof value === "string"
            ? encoder.encode(value)
            : value instanceof Uint8Array
              ? new Uint8Array(value)
              : new Uint8Array(value);
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
  "  index.md: team",
  "  1-projects: team",
  "  1-projects/vault: private",
  "",
  "note_overrides:",
  "```",
  "",
  "<!-- END BRAIN PRIVACY RULES -->",
  "",
].join("\n");

/**
 * Two obviously fake AES-256 keys, base64.
 *
 * They are literals rather than generated so that "A's key does not open B's
 * note" is a claim about *these two* keys on every run, and so that a failure
 * is reproducible rather than a coin flip.
 */
const KEY_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
const KEY_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

const SECRET_BODY = [
  "---",
  "updated: 2026-09-07",
  "tags: [payroll]",
  "---",
  "",
  "# Compensation review",
  "",
  "The number is forty-two, and it links to [[1-projects/alpha]].",
  "",
].join("\n");

export async function runEncryptionGatewayChecks(check) {
  const a = makeBucket();
  const b = makeBucket();
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();

  try {
    controlPlane.addWorkspace("ws_enc_a", "enca", {
      provider: "r2-binding",
      bindingName: "BUCKET_A",
      capabilities: { conditionalWrite: true },
      status: "active",
      encryptionKey: { current: "k1", keys: { k1: KEY_A } },
    });
    controlPlane.addWorkspace("ws_enc_b", "encb", {
      provider: "r2-binding",
      bindingName: "BUCKET_B",
      capabilities: { conditionalWrite: true },
      status: "active",
      encryptionKey: { current: "k1", keys: { k1: KEY_B } },
    });
    // The third context is the ordinary one: a workspace that has never
    // encrypted anything, so the control plane sends no key at all. Every
    // context in the product is this one today, which is why it gets its own
    // grant rather than being simulated by a flag.
    controlPlane.addWorkspace("ws_enc_none", "encnone", {
      provider: "r2-binding",
      bindingName: "BUCKET_A",
      capabilities: { conditionalWrite: true },
      status: "active",
    });

    const OWNER_A = "cat_test_enc_owner_a_000000000000000";
    const TEAM_A = "cat_test_enc_team_a_0000000000000000";
    const OWNER_B = "cat_test_enc_owner_b_000000000000000";
    const KEYLESS = "cat_test_enc_keyless_0000000000000000";
    await controlPlane.addGrant({
      accessToken: OWNER_A,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_a",
      userId: "user_enc_owner_a",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_A,
      workspaceId: "ws_enc_a",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_enc_team_a",
      userId: "user_enc_team_a",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_B,
      workspaceId: "ws_enc_b",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_b",
      userId: "user_enc_owner_b",
    });
    /*
      THE DESKTOP MACHINE GRANT, exactly as `apps/desktop/src/main/connect.ts`
      asks for it: `DESKTOP_SCOPE` is `"context:write context:private"` and
      deliberately NOT `context:read`, because — its words — "a laptop
      credential that could read every note its owner ever wrote is past what
      the feature is worth."

      It is minted with no approve screen at all: the console page answers the
      parked request with the session it already holds. So this is the widest
      credential in the product that nobody was ever shown a screen for, and
      what it may reach is worth pinning rather than assuming.
    */
    const MACHINE_A = "cat_test_enc_machine_a_000000000000000";
    await controlPlane.addGrant({
      accessToken: MACHINE_A,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:write", "context:private"],
      clientId: "mcp_client_enc_machine_a",
      userId: "user_enc_machine_a",
    });
    await controlPlane.addGrant({
      accessToken: KEYLESS,
      workspaceId: "ws_enc_none",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_keyless",
      userId: "user_enc_keyless",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "BUCKET_A,BUCKET_B",
      BUCKET_A: a.bucket,
      BUCKET_B: b.bucket,
    };

    let id = 0;
    async function call(token, name, args = {}) {
      const res = await worker.fetch(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
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
    const readB = (key) => {
      const entry = b.objects.get(key);
      return entry ? new TextDecoder().decode(entry.bytes) : undefined;
    };

    const storeA = new R2Store(a.bucket);
    const storeB = new R2Store(b.bucket);
    for (const store of [storeA, storeB]) {
      await store.put("privacy.md", PRIVACY);
      await store.put("index.md", "# front page\n");
    }
    await storeA.put("1-projects/alpha.md", "# alpha\n\npoints at [[1-projects/team-secret]]\n");
    await storeA.put("1-projects/team-secret.md", SECRET_BODY);
    await storeA.put("1-projects/vault/private-secret.md", SECRET_BODY);

    /* -- (1) turning it on -------------------------------------------------- */

    const refusedTeam = await call(TEAM_A, "set_encryption", {
      path: "1-projects/team-secret.md",
      encrypted: true,
    });
    check(
      "a team connection cannot encrypt a note",
      refusedTeam?.isError === true && /only a personal connection/.test(textOf(refusedTeam)),
    );
    check(
      "...and nothing was written",
      readA("1-projects/team-secret.md") === SECRET_BODY,
    );

    const encrypted = await call(OWNER_A, "set_encryption", {
      path: "1-projects/team-secret.md",
      encrypted: true,
    });
    check(
      "an owner can encrypt a note, and is told what that did and did not do",
      !encrypted?.isError &&
        /^encrypted: 1-projects\/team-secret\.md/.test(textOf(encrypted)) &&
        /no longer searchable/.test(textOf(encrypted)),
    );

    const storedSecret = readA("1-projects/team-secret.md");
    check(
      "the bucket now holds ciphertext and no fragment of the plaintext",
      isEncryptedNote(storedSecret) &&
        !storedSecret.includes("forty-two") &&
        !storedSecret.includes("payroll") &&
        !storedSecret.includes("1-projects/alpha"),
    );
    check(
      "...and it is still a file at its own path, marked so a human can see it",
      storedSecret.startsWith("---\ncontext_encryption: v1\n") &&
        storedSecret.includes("This note is encrypted."),
    );
    check(
      "...and the key itself is nowhere in the bucket",
      !storedSecret.includes(KEY_A) && !readA("privacy.md").includes(KEY_A),
    );

    const again = await call(OWNER_A, "set_encryption", {
      path: "1-projects/team-secret.md",
      encrypted: true,
    });
    check(
      "encrypting an encrypted note is answered, not performed",
      !again?.isError &&
        /already encrypted/.test(textOf(again)) &&
        readA("1-projects/team-secret.md") === storedSecret,
    );

    /* -- (2) reading it back ------------------------------------------------ */

    const readBack = await call(OWNER_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "the owner reads the plaintext back, whole",
      !readBack?.isError && textOf(readBack).endsWith(SECRET_BODY),
    );
    check(
      "...and is told the note is encrypted",
      /\nencryption: v1\n/.test(textOf(readBack)),
    );

    // The half that proves encryption is orthogonal to visibility rather than a
    // second private tier: this note is `team`, so the team connection reads it.
    const teamRead = await call(TEAM_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "a team connection reads an encrypted TEAM note, decrypted",
      !teamRead?.isError && textOf(teamRead).endsWith(SECRET_BODY),
    );

    /* -- (3) a team caller cannot infer a private encrypted note ------------ */

    await call(OWNER_A, "set_encryption", {
      path: "1-projects/vault/private-secret.md",
      encrypted: true,
    });
    const hiddenReal = await call(TEAM_A, "read_note", {
      path: "1-projects/vault/private-secret.md",
    });
    const hiddenInvented = await call(TEAM_A, "read_note", {
      path: "1-projects/vault/no-such-note.md",
    });
    check(
      "a team connection is refused a private encrypted note",
      hiddenReal?.isError === true,
    );
    check(
      "...with the byte-identical refusal a path that never existed gets",
      textOf(hiddenReal) === textOf(hiddenInvented) && textOf(hiddenReal) === "not found",
    );
    const teamList = await call(TEAM_A, "list_notes", { prefix: "1-projects" });
    check(
      "...and it is not listed, encrypted or otherwise",
      !textOf(teamList).includes("private-secret.md"),
    );

    /* -- (4) tenant isolation: the same bytes, the other tenant ------------- */

    await storeB.put("1-projects/stolen.md", storedSecret);
    const stolen = await call(OWNER_B, "read_note", { path: "1-projects/stolen.md" });
    check(
      "another workspace's key does not open this workspace's ciphertext",
      stolen?.isError === true && /encrypted and this connection cannot open it/.test(textOf(stolen)),
    );
    check(
      "...and the refusal is not the ciphertext with a warning on it",
      !textOf(stolen).includes(parseEncryptedNote(storedSecret).ct.slice(0, 32)),
    );
    // Non-vacuity: B is a working context that can encrypt and read its own.
    await storeB.put("1-projects/own.md", "# b's own note\n\nthe number is nine\n");
    await call(OWNER_B, "set_encryption", { path: "1-projects/own.md", encrypted: true });
    const bOwn = await call(OWNER_B, "read_note", { path: "1-projects/own.md" });
    check(
      "...while B reads B's own encrypted note perfectly well",
      !bOwn?.isError && textOf(bOwn).endsWith("# b's own note\n\nthe number is nine\n"),
    );

    /* -- (5) a round trip is not a downgrade -------------------------------- */

    const echoed = await call(OWNER_A, "write_note", {
      path: "1-projects/team-secret.md",
      content: `${SECRET_BODY}\nAnd one more line.\n`,
    });
    check("a plaintext write to an encrypted note succeeds", !echoed?.isError);
    check(
      "...and the note is still stored as ciphertext",
      isEncryptedNote(readA("1-projects/team-secret.md")) &&
        !readA("1-projects/team-secret.md").includes("And one more line."),
    );
    const afterEcho = await call(OWNER_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "...and it reads back as exactly what was written",
      textOf(afterEcho).endsWith(`${SECRET_BODY}\nAnd one more line.\n`),
    );

    // The other direction of the same rule: a client that posts something
    // envelope-shaped is writing *content*, not an envelope. Storing it raw
    // would let any writer replace a note with a document nothing can open.
    const envelopeShaped = readA("1-projects/team-secret.md");
    await call(OWNER_A, "write_note", {
      path: "1-projects/team-secret.md",
      content: envelopeShaped,
    });
    const nested = await call(OWNER_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "an envelope-shaped body is stored as content, encrypted, not as a raw envelope",
      isEncryptedNote(readA("1-projects/team-secret.md")) &&
        textOf(nested).includes("context_encryption: v1") &&
        readA("1-projects/team-secret.md") !== envelopeShaped,
    );
    // Put it back, so the checks below are about a note and not about that one.
    await call(OWNER_A, "write_note", {
      path: "1-projects/team-secret.md",
      content: SECRET_BODY,
    });

    /* -- (6) a move does not touch the bytes -------------------------------- */

    const before = readA("1-projects/team-secret.md");
    const moved = await call(OWNER_A, "move_note", {
      source: "1-projects/team-secret.md",
      destination: "1-projects/moved-secret.md",
    });
    check("an encrypted note moves", !moved?.isError);
    check(
      "...and its ciphertext is byte-for-byte what it was",
      readA("1-projects/moved-secret.md") === before &&
        readA("1-projects/team-secret.md") === undefined,
    );
    const afterMove = await call(OWNER_A, "read_note", { path: "1-projects/moved-secret.md" });
    check(
      "...and it still opens at the new path, which is what binding the AAD to the workspace buys",
      !afterMove?.isError && textOf(afterMove).endsWith(SECRET_BODY),
    );

    /* -- (7) a link rewrite leaves it alone, and still rewrites the rest ---- */

    await storeA.put(
      "1-projects/pointer.md",
      "# pointer\n\npoints at [[1-projects/alpha]]\n",
    );
    const ciphertextBefore = readA("1-projects/moved-secret.md");
    const renamed = await call(OWNER_A, "move_note", {
      source: "1-projects/alpha.md",
      destination: "1-projects/renamed.md",
    });
    check("the neighbour's rename succeeds", !renamed?.isError);
    check(
      "a plaintext note pointing at it was rewritten",
      readA("1-projects/pointer.md") === "# pointer\n\npoints at [[1-projects/renamed]]\n",
    );
    check(
      "...and the encrypted note's bytes were not touched at all",
      readA("1-projects/moved-secret.md") === ciphertextBefore,
    );

    /* -- (8) search never quotes one ---------------------------------------- */

    /*
     * THIS ONE FIRST, AND THE ORDER IS THE TEST.
     *
     * Nothing has searched this context yet, so there is no index and the query
     * falls to the literal scan — the recovery path that reads live bytes out
     * of the bucket. "A256GCM" is a string that appears in every envelope and
     * in no note anybody writes, so it is the one needle that can tell a scan
     * which skips encrypted notes from a scan which happily matches their
     * wrapper and cuts a snippet out of it.
     *
     * A later search would prove nothing here: by then the index exists, it
     * holds the note as the empty string, and the scan is not reached at all.
     */
    const scanned = await call(OWNER_A, "search_notes", { query: "A256GCM" });
    check(
      "the literal scan does not match an encrypted note's own envelope",
      !textOf(scanned).includes("moved-secret") && !textOf(scanned).includes("A256GCM"),
    );

    const searched = await call(OWNER_A, "search_notes", { query: "forty-two" });
    check(
      "search does not find an encrypted note's content",
      !textOf(searched).includes("moved-secret") && !textOf(searched).includes("forty-two"),
    );
    // Non-vacuity: the same word in a plaintext note is found, so the check
    // above is not passing because search is broken.
    await storeA.put("1-projects/open.md", "# open\n\nthe number is forty-two here\n");
    const searchedOpen = await call(OWNER_A, "search_notes", { query: "forty-two" });
    check(
      "...while the same word in a plaintext note is found",
      textOf(searchedOpen).includes("1-projects/open.md"),
    );

    /*
     * AND THE COUNT MUST NOT COUNT WHAT THE HITS DO NOT SHOW.
     *
     * `visible.js` drops an encrypted note when it reads the body for a
     * snippet, but `matchCount` is `visible.length` — taken before that drop.
     * The index holds the note with empty content, so no body term ranks it,
     * but its PATH still can: MEASURED, a search for "moved" answered
     * "2 matching notes — the 1 best shown" with the encrypted note counted
     * and withheld.
     *
     * The word is NOT unique to `1-projects/moved-secret.md`, and an earlier
     * version of this comment said it was — contradicted by the check twelve
     * lines below, which asserts the plaintext hit and calls it correct. The
     * move rewrote `1-projects/alpha.md`'s link to `[[1-projects/moved-secret]]`
     * before that note was renamed, so the word is in a body this caller may
     * read. Which is why the assertion is about the COUNT rather than about
     * where the word occurs.
     *
     * Nothing leaks: `rankedVisibleTo` runs first, so only notes this caller
     * may see are ever counted, and the byte-identical promise
     * `docs/decisions/encryption.md` makes to a team-tier caller is untouched.
     * What is wrong is that `search does not find encrypted notes` is stated
     * flatly while the count still counts them, and "the N best shown" tells an
     * agent there is another match to page to when there is not.
     */
    const counted = await call(OWNER_A, "search_notes", { query: "moved" });
    const countedText = textOf(counted);
    const headline = countedText.split("\n")[0] ?? "";
    const shown = (countedText.match(/^1-projects\//gm) ?? []).length;
    const claimed = Number(headline.match(/^(\d+)/)?.[1] ?? "0");
    check(
      "THE MATCH COUNT DOES NOT COUNT AN ENCRYPTED NOTE IT WILL NOT SHOW",
      headline === "(no matches)" ? shown === 0 : claimed === shown,
    );
    check(
      "...and the one hit shown is the plaintext note that legitimately links to it",
      /*
        NOT "the encrypted note is never named". That assertion was written
        first and was false for a good reason: `1-projects/renamed.md` is a
        plaintext note whose body holds `[[1-projects/moved-secret]]`, and a
        search quoting its own body is correct. What must not appear is the
        encrypted note as a HIT of its own.
      */
      countedText.includes("1-projects/renamed.md") &&
        !/^1-projects\/moved-secret\.md$/m.test(countedText),
    );

    const fetched = await call(OWNER_A, "fetch", { id: "1-projects/moved-secret.md" });
    check(
      "the ChatGPT fetch dialect returns the plaintext for a caller that holds the key",
      !fetched?.isError && JSON.parse(textOf(fetched)).text.includes("forty-two"),
    );
    const fetchedStolen = await call(OWNER_B, "fetch", { id: "1-projects/stolen.md" });
    check(
      "...and refuses rather than putting ciphertext in a chat transcript",
      fetchedStolen?.isError === true,
    );

    check(
      "an encrypted note reaches both indexes as the empty string",
      indexableText(ciphertextBefore) === "" && indexableText(SECRET_BODY) === SECRET_BODY,
    );

    /*
     * AND THE INDEX THAT WAS ACTUALLY BUILT HOLDS NONE OF IT.
     *
     * The line above is a unit assertion about `indexableText`, and it was the
     * whole of the evidence for "nothing of an encrypted note reaches the
     * index". MEASURED: it was not true. `syncShardedIndex` — the pass every
     * search and every scheduled sweep actually runs — read note bodies with a
     * bare `object.text()`, so an envelope's own terms (`a256gcm`,
     * `context-encrypted`, the callout's words, the base64url of `ct`) were
     * tokenised into `.index/v2/shard-*.json`, an object that lives **in the
     * customer's own bucket under the same credential as the note**. The
     * `indexableText` call the decision file points at lived in `syncIndex`,
     * which nothing has called since the v2 index landed.
     *
     * That is not a plaintext leak — the terms come from the ciphertext the
     * bucket already holds — and it is exactly the shape `testing.md` calls a
     * guard nobody has checked: the assertion above passes for an
     * implementation that never calls the function it asserts about.
     *
     * So this asks the index itself, in both directions, because an assertion
     * that only checks for absence passes just as well against an index that
     * was never built.
     */
    const indexObjects = [...a.objects.keys()]
      .filter((key) => key.startsWith(".index/"))
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "the index that was really built holds the plaintext notes it should",
      indexObjects.length > 0 && indexObjects.includes("pointer"),
    );
    check(
      "...and not one term of an encrypted note's envelope",
      !/a256gcm/i.test(indexObjects) &&
        !indexObjects.includes(FENCE_LANGUAGE) &&
        !indexObjects.includes(parseEncryptedNote(ciphertextBefore).ct.slice(0, 24)),
    );

    /*
     * THE LINK REWRITER'S SKIP, ASKED THE ONLY WAY IT CAN BE ASKED.
     *
     * Deleting `rewriteReferences`' `isEncryptedNote` guard breaks nothing
     * measurable today, and that is worth stating rather than hiding behind a
     * sabotage count of zero. The reason is this line: an envelope contains
     * nothing a link parser can match. `ct` is base64url, whose alphabet has no
     * brackets at all, and the surrounding JSON has no `[[` and no `](`.
     *
     * So the skip is a margin rather than a load-bearing check — and this is
     * what keeps it one. The day the envelope grows a field that can carry a
     * bracket, this fails, and the skip is what stops a link rewrite corrupting
     * a note nothing can then recover.
     */
    check(
      "an envelope carries nothing a link rewriter could match",
      parseLinks(ciphertextBefore).length === 0,
    );

    /* -- (9) no key is a locked note, never a lost one ---------------------- */

    // `ws_enc_none` is bound to the same bucket and holds no key.
    const lockedRead = await call(KEYLESS, "read_note", { path: "1-projects/moved-secret.md" });
    check(
      "a context with no key is refused an encrypted note, and told what it is",
      lockedRead?.isError === true &&
        /encrypted and this connection cannot open it/.test(textOf(lockedRead)),
    );
    check(
      "...and its plaintext notes still read perfectly well",
      !(await call(KEYLESS, "read_note", { path: "1-projects/open.md" }))?.isError,
    );
    const lockedWrite = await call(KEYLESS, "write_note", {
      path: "1-projects/moved-secret.md",
      content: "# I am replacing this with plaintext\n",
    });
    check(
      "...and it CANNOT overwrite an encrypted note with plaintext",
      lockedWrite?.isError === true &&
        readA("1-projects/moved-secret.md") === ciphertextBefore,
    );
    const lockedEncrypt = await call(KEYLESS, "set_encryption", {
      path: "1-projects/open.md",
      encrypted: true,
    });
    check(
      "...and it cannot encrypt a note into a form nothing could open",
      lockedEncrypt?.isError === true &&
        !isEncryptedNote(readA("1-projects/open.md")),
    );

    /* -- (10) and off means off --------------------------------------------- */

    const decrypted = await call(OWNER_A, "set_encryption", {
      path: "1-projects/moved-secret.md",
      encrypted: false,
    });
    check(
      "an owner can decrypt a note again",
      !decrypted?.isError && readA("1-projects/moved-secret.md") === SECRET_BODY,
    );
    check(
      "...and it stops being excluded from the indexes",
      indexableText(readA("1-projects/moved-secret.md")) === SECRET_BODY,
    );
    // Asserted on the exclusion rather than on a search result, and the
    // difference is real rather than a convenience. The index still holds the
    // empty row it was given while the note was encrypted, and the pass that
    // replaces it runs behind the response — which this harness discards, and
    // which in production is the same one reconcile interval every other stale
    // row waits for. Asserting "a search finds it now" would be asserting that
    // the index is synchronous, which it is not and never was.
    const searchedAfter = await call(OWNER_A, "search_notes", { query: "forty-two" });
    check(
      "...and searching still works, from the index as it stands",
      !searchedAfter?.isError && textOf(searchedAfter).includes("1-projects/open.md"),
    );
    const decryptAgain = await call(OWNER_A, "set_encryption", {
      path: "1-projects/moved-secret.md",
      encrypted: false,
    });
    check(
      "decrypting a plaintext note is answered, not performed",
      !decryptAgain?.isError && /already stored as plain markdown/.test(textOf(decryptAgain)),
    );

    /* -- (11) the conflict body is the other way to hand back an envelope ---- */
    //
    // `write_note`'s stale-etag branch returns the note's *current content* and
    // tells the client to merge into it. That is a second place a caller is
    // handed a body, and if it were the stored bytes the client would merge its
    // change into base64 and post the result — which the write path would then
    // store as the note's new plaintext content. The refusal direction matters
    // as much: a caller with no key must not receive the envelope here either.

    await storeA.put("1-projects/conflict.md", SECRET_BODY);
    await call(OWNER_A, "set_encryption", { path: "1-projects/conflict.md", encrypted: true });
    const conflictCiphertext = readA("1-projects/conflict.md");

    const stale = await call(OWNER_A, "write_note", {
      path: "1-projects/conflict.md",
      content: "# whatever\n",
      expected_etag: "etag-nobody-ever-minted",
    });
    check(
      "a stale-etag write to an encrypted note is refused, not applied",
      stale?.isError === true && /conflict/.test(textOf(stale)),
    );
    check(
      "...and the envelope in the bucket is byte-for-byte unchanged",
      readA("1-projects/conflict.md") === conflictCiphertext,
    );
    check(
      "...and the body it hands back to merge into is the plaintext, never the envelope",
      textOf(stale).includes("# Compensation review") &&
        !textOf(stale).includes("context-encrypted") &&
        !textOf(stale).includes("A256GCM"),
    );

    // The same branch, for a connection that holds no key. It cannot open the
    // note, so there is nothing it could correctly be told to merge into — and
    // the one answer it must not get is the ciphertext.
    const keylessConflict = await call(KEYLESS, "write_note", {
      path: "1-projects/conflict.md",
      content: "# whatever\n",
      expected_etag: "etag-nobody-ever-minted",
    });
    check(
      "a keyless connection's stale-etag write is refused as locked, not answered with ciphertext",
      keylessConflict?.isError === true &&
        /encrypted/.test(textOf(keylessConflict)) &&
        !textOf(keylessConflict).includes("A256GCM") &&
        !textOf(keylessConflict).includes("context-encrypted"),
    );
    check(
      "...and it changed nothing either",
      readA("1-projects/conflict.md") === conflictCiphertext,
    );

    /* -- (12) nothing of the plaintext reaches a log ------------------------- */
    //
    // "Structured logs carry request, workspace and grant identifiers, never
    // secrets and never note content." An encrypted note is the sharpest case
    // of that rule, and it is the one place a refusal is deliberately *not*
    // uniform — so the message it logs has to be checked rather than assumed.
    // Every line the worker emits across a full cycle is swept, for the
    // plaintext, for the key, and for the envelope.

    const logLines = [];
    const realLog = console.log;
    console.log = (...args) => logLines.push(args.map(String).join(" "));
    try {
      await call(OWNER_A, "read_note", { path: "1-projects/conflict.md" });
      await call(TEAM_A, "read_note", { path: "1-projects/vault/private-secret.md" });
      await call(KEYLESS, "read_note", { path: "1-projects/conflict.md" });
      await call(OWNER_A, "search_notes", { query: "forty-two" });
      await call(OWNER_A, "list_changes", {});
      await call(OWNER_A, "set_encryption", {
        path: "1-projects/conflict.md",
        encrypted: false,
      });
      await call(OWNER_A, "set_encryption", {
        path: "1-projects/conflict.md",
        encrypted: true,
      });
    } finally {
      console.log = realLog;
    }
    const logged = logLines.join("\n");
    check(
      "no log line carries the plaintext of an encrypted note",
      logLines.length > 0 &&
        !logged.includes("forty-two") &&
        !logged.includes("Compensation review") &&
        !logged.includes("payroll"),
    );
    check(
      "...nor the workspace data key, in either alphabet",
      !logged.includes(KEY_A) &&
        !logged.includes(KEY_B) &&
        !logged.includes(KEY_A.slice(0, 16)) &&
        !logged.includes(KEY_B.slice(0, 16)),
    );
    check(
      "...nor an envelope, which is somebody's bytes even where it is unreadable",
      !logged.includes("context-encrypted") && !logged.includes("A256GCM"),
    );

    /* -- (13) and the audit trail records the path, never the content ------- */

    const auditKeys = [...a.objects.keys()].filter((key) => key.startsWith(".audit/"));
    const audit = auditKeys
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "the audit trail records that a note was encrypted, and names it",
      auditKeys.length > 0 &&
        /encrypt_note/.test(audit) &&
        audit.includes("1-projects/conflict.md"),
    );
    check(
      "...and carries none of its content, and no envelope, and no key",
      !audit.includes("forty-two") &&
        !audit.includes("Compensation review") &&
        !audit.includes("A256GCM") &&
        !audit.includes(KEY_A.slice(0, 16)),
    );

    /* -- (14) a passphrase-locked note, which this gateway is not a reader of */
    //
    // The Phase 2 mode, and the one this section exists to police: a note whose
    // only recipient is a passphrase. Nothing here can open it, no tool takes a
    // passphrase, and the failure that would be catastrophic is not "a client
    // cannot read it" — it is a client *writing* to it, because the gateway
    // would otherwise have sealed the replacement with the workspace key and
    // reported success while destroying the only copy of the note.
    //
    // Every call below runs inside a log capture, and the checks run after it is
    // released — a check that prints into its own evidence is a check nobody can
    // read, and the first version of this section did exactly that.

    const LOCKED = "1-projects/locked.md";
    const lockedBytes = PASSPHRASE_VECTOR.document.replace(
      PASSPHRASE_VECTOR.workspaceId,
      "ws_enc_a",
    );
    await storeA.put(LOCKED, lockedBytes);
    await storeA.put("1-projects/keyless.md", readA("1-projects/conflict.md") ?? lockedBytes);

    const lockedBefore = readA(LOCKED);
    const lockedLines = [];
    const realLockedLog = console.log;
    let locked;
    console.log = (...args) => lockedLines.push(args.map(String).join(" "));
    try {
      locked = {
        read: await call(OWNER_A, "read_note", { path: LOCKED }),
        // The same refusal a note whose *key* did not arrive gets. Two reasons,
        // one answer: a client cannot learn from a refusal whether a note is
        // passphrase-locked or merely unreachable today, so Phase 2 adds no
        // inference channel that Phase 1 did not already have.
        keyless: await call(KEYLESS, "read_note", { path: "1-projects/keyless.md" }),
        write: await call(OWNER_A, "write_note", {
          path: LOCKED,
          content: "# I am overwriting this\n",
        }),
        // The argument that does not exist. A client that has heard of the
        // feature and guesses at an interface must not find one.
        writeWithPassphrase: await call(OWNER_A, "write_note", {
          path: LOCKED,
          content: "# I am overwriting this\n",
          passphrase: PASSPHRASE_VECTOR.passphrase,
          password: PASSPHRASE_VECTOR.passphrase,
        }),
        readWithPassphrase: await call(OWNER_A, "read_note", {
          path: LOCKED,
          passphrase: PASSPHRASE_VECTOR.passphrase,
        }),
        decrypt: await call(OWNER_A, "set_encryption", {
          path: LOCKED,
          encrypted: false,
          passphrase: PASSPHRASE_VECTOR.passphrase,
        }),
        search: await call(OWNER_A, "search_notes", { query: "pinned passphrase vector" }),
        list: await call(OWNER_A, "list_notes", { prefix: "1-projects" }),
        tools: await (async () => {
          const res = await worker.fetch(
            new Request("https://x/mcp", {
              method: "POST",
              headers: { Authorization: `Bearer ${OWNER_A}`, "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "tools/list" }),
            }),
            env,
            { waitUntil() {} },
          );
          return (await res.json()).result.tools;
        })(),
      };
    } finally {
      console.log = realLockedLog;
    }
    const lockedAfter = readA(LOCKED);

    check(
      "a client cannot read a passphrase-locked note, and is not handed its envelope",
      textOf(locked.read).includes("encrypted") &&
        !textOf(locked.read).includes("A256GCM") &&
        !textOf(locked.read).includes("pinned passphrase vector"),
    );
    check(
      "...and the refusal is the same shape as the one a missing key produces",
      textOf(locked.read).replace(LOCKED, "\u00abpath\u00bb") ===
        textOf(locked.keyless).replace("1-projects/keyless.md", "\u00abpath\u00bb"),
    );
    check(
      "a write to a passphrase-locked note is refused",
      textOf(locked.write).includes("encrypted") && !textOf(locked.write).includes("written:"),
    );
    check("...and the stored object is byte-for-byte what it was", lockedAfter === lockedBefore);
    check(
      "...and supplying a passphrase to the gateway changes nothing at all",
      textOf(locked.writeWithPassphrase) === textOf(locked.write),
    );
    check("...on the read path either", textOf(locked.readWithPassphrase) === textOf(locked.read));
    check(
      "...and `set_encryption` cannot turn the lock off with one",
      !textOf(locked.decrypt).includes("decrypted:"),
    );
    check(
      "no tool this gateway advertises takes a passphrase, a password or a key",
      locked.tools.every((tool) =>
        Object.keys(tool.inputSchema?.properties ?? {}).every(
          (name) => !/pass(phrase|word)|secret|kek|key$/i.test(name),
        ),
      ),
    );
    check(
      "search does not quote a passphrase-locked note",
      !textOf(locked.search).includes("Only the passphrase beside this"),
    );
    check(
      "...and the note is still listed, because its existence was never the secret",
      textOf(locked.list).includes("locked.md"),
    );

    const lockedLog = JSON.stringify(lockedLines);
    check(
      "nothing about a locked note reaches a log line but its path",
      lockedLines.length > 0 &&
        !lockedLog.includes(PASSPHRASE_VECTOR.passphrase) &&
        !lockedLog.includes(PASSPHRASE_VECTOR.kek) &&
        !lockedLog.includes("Only the passphrase beside this"),
    );
    const lockedAudit = [...a.objects.keys()]
      .filter((key) => key.startsWith(".audit/"))
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "...and no audit row carries a passphrase, because no call ever had one to record",
      !lockedAudit.includes(PASSPHRASE_VECTOR.passphrase) &&
        !lockedAudit.includes(PASSPHRASE_VECTOR.kek),
    );

    /*
      WHAT KEEPS THE DESKTOP MACHINE GRANT AWAY FROM THE KEYS, and it is not
      the gate on the tool.

      This block exists because a review of mine got it wrong and the wrong
      version is the one worth pinning against. The reasoning was: the tool is
      gated only on `scope !== "private"`; `scope` is the visibility TIER, and
      `visibilityTierForGrant` answers `"private"` for any owner-held grant
      carrying `context:private`; `DESKTOP_SCOPE` is exactly
      `context:write context:private`; the tool is `readOnlyHint: true` so
      `toolIsWriting` is false and the operation-scope gate is skipped. Every
      one of those is true. The conclusion — that a machine grant can export
      the workspace keys — is false, because none of them is reached.

      `/mcp` requires `context:read` at the transport, before a store exists
      and before any tool is dispatched. A grant without it gets `403
      insufficient_scope` and never sees a tool at all. So the credential that
      is minted with no approve screen is kept out by the scope its own design
      deliberately omits — which is the property `main/connect.ts` claims when
      it says "a laptop credential that could read every note its owner ever
      wrote is past what the feature is worth."

      Pinned here rather than assumed, because the reasoning above is what a
      future change to that transport gate would silently unlock, and because
      an enumeration of the gates INSIDE a dispatcher says nothing about the
      one in front of it.
    */
    const machineRaw = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${MACHINE_A}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9911,
          method: "tools/call",
          params: { name: "export_encryption_keys", arguments: {} },
        }),
      }),
      env,
      { waitUntil() {} },
    );
    const machineBody = await machineRaw.json();
    check(
      "THE DESKTOP MACHINE GRANT NEVER REACHES A TOOL: /mcp REQUIRES context:read",
      machineRaw.status === 403 && machineBody?.error === "insufficient_scope",
    );
    check(
      "...and the refusal names the scope, so a client knows what to ask for",
      String(machineBody?.error_description || "").includes("context:read"),
    );
    /*
      Deliberately not asserted here: that this grant is otherwise live. The
      obvious demonstration — a meetings GET — is refused for scope too, since
      `scopeForMeetingRequest` wants read for a read. What this credential can
      actually do is POST a meeting, which needs a real body and belongs in the
      meetings suite that already covers it. A check that cannot make its point
      without contortion is better left out than stretched into one that
      passes; the first version of it asserted `!== 401 && !== 403` and would
      have gone green on a fixture that was simply broken.
    */

    /* -- (15) export_encryption_keys ---------------------------------------- */

    const teamExport = await call(TEAM_A, "export_encryption_keys", {});
    check(
      "a team connection cannot see export_encryption_keys exists",
      teamExport?.isError === true && textOf(teamExport) === "unknown tool: export_encryption_keys",
    );

    /*
      THE OTHER HALF OF "DOES NOT EVEN LEARN THE TOOL EXISTS", and the half
      that was missing: the refusal above says `unknown tool` while
      `tools/list` was, until this check existed, handing the same connection
      the name, the description and the sentence "Export this context's
      workspace data key(s) in the clear". A masked refusal about a capability
      the same connection was just advertised masks nothing.

      Asked on the listing AND on the call, because either alone passes for a
      gateway that gets the other one wrong.
    */
    const listedFor = async (token) => {
      const res = await worker.fetch(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }),
        }),
        env,
        { waitUntil() {} },
      );
      return ((await res.json()).result?.tools ?? []).map((tool) => tool.name);
    };
    const ownerTools = await listedFor(OWNER_A);
    const teamTools = await listedFor(TEAM_A);
    check(
      "an owner is offered both encryption tools",
      ownerTools.includes("export_encryption_keys") && ownerTools.includes("rotate_encryption_keys"),
    );
    check(
      "a team connection is not offered either of them — the listing masks what the call masks",
      !teamTools.includes("export_encryption_keys") &&
        !teamTools.includes("rotate_encryption_keys") &&
        // and the listing is not simply empty for that connection
        teamTools.includes("read_note"),
    );

    /*
      BYTE-IDENTICAL, asserted on the whole payload rather than on the message.
      `canSee`'s own idiom is that the refusal for a thing you may not have is
      indistinguishable from the refusal for a thing that never existed, and a
      check on the text alone would pass for a payload that differed in
      `isError`, in a second content block, or in a `_meta` hint.
    */
    const invented = await call(TEAM_A, "export_encryption_keys_x", {});
    check(
      "the refusal is byte-identical to the one an invented tool name gets",
      JSON.stringify(teamExport).replace("export_encryption_keys", "export_encryption_keys_x") ===
        JSON.stringify(invented),
    );

    /*
      NAMING SOMEBODY ELSE'S CONTEXT.

      The tool takes no arguments, so the only id an attacker can supply is the
      routing one — `context`, which `callToolForSession` resolves before the
      tool runs. A connection that owns context A and is merely an *editor* in
      context B holds `context:private` in the grant and reads private in A,
      so the tool is legitimately theirs *there*: the question is whether the
      capability travels with the connection or is re-decided in the context it
      is routed to. It is re-decided — `target.scope` for B is `team`, and the
      answer is the same masked refusal, with none of B's key material in it.
    */
    const OWNER_A_IN_B = "cat_test_enc_owner_a_in_b_0000000000";
    await controlPlane.addGrant({
      accessToken: OWNER_A_IN_B,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_a_in_b",
      userId: "user_enc_owner_a_in_b",
      alsoMemberOf: [{ workspaceId: "ws_enc_b", role: "editor" }],
    });
    const crossExport = await call(OWNER_A_IN_B, "export_encryption_keys", { context: "@encb" });
    check(
      "an owner of one context cannot export the key of another they are only an editor in",
      crossExport?.isError === true &&
        textOf(crossExport) === "unknown tool: export_encryption_keys" &&
        !textOf(crossExport).includes(KEY_B),
    );
    const crossRotate = await call(OWNER_A_IN_B, "rotate_encryption_keys", { context: "@encb" });
    check(
      "...and cannot rotate it either",
      crossRotate?.isError === true && textOf(crossRotate) === "unknown tool: rotate_encryption_keys",
    );
    const strangerExport = await call(OWNER_B, "export_encryption_keys", { context: "@enca" });
    check(
      "a context the connection is not a member of at all answers with no-access, not with a key",
      strangerExport?.isError === true &&
        !textOf(strangerExport).includes(KEY_A) &&
        /no access to that context/.test(textOf(strangerExport)),
    );

    const keylessExport = await call(KEYLESS, "export_encryption_keys", {});
    check(
      "a context that has never encrypted anything has nothing to export, and it is not a refusal",
      !keylessExport?.isError && /nothing to export/.test(textOf(keylessExport)),
    );

    const exported = await call(OWNER_A, "export_encryption_keys", {});
    const exportedText = textOf(exported);
    const exportedDoc = JSON.parse(exportedText.slice(exportedText.indexOf("{")));
    check(
      "the export names the workspace, the current generation, and includes the live key",
      !exported?.isError &&
        exportedDoc.workspace_id === "ws_enc_a" &&
        exportedDoc.current === "k1" &&
        exportedDoc.keys.length === 1 &&
        exportedDoc.keys[0].generation === "k1" &&
        exportedDoc.keys[0].key === KEY_A,
    );
    /*
      AND NAMING IT IN EVERY OTHER ARGUMENT THE ROUTE ACCEPTS.

      `context` is the *routing* argument and it is re-decided in the context
      it points at, which the two checks above ask. This asks the rest of the
      surface. `inputSchema` declares `properties: {}` with
      `additionalProperties: false`, but this gateway does not validate a
      tool's arguments against its own schema — `callTool` hands the object
      straight through — so "this tool takes no arguments" is a statement
      about the advertisement, not about the door. What makes it true of the
      door is that `toolExportEncryptionKeys(store, scope)` and
      `toolRotateEncryptionKeys(store, scope)` are the only two tool functions
      in `index.js` that do not take `args` at all, and so have nothing to
      read an attacker-supplied id out of.

      Asserted rather than read off the signature, because a later refactor
      that added `args` "for symmetry" is a one-line change with no test
      standing in front of it. Every name these two routes could plausibly
      grow — the control plane's own field names included,
      `startEncryptionRotation` and `completeEncryptionRotation` among them —
      carrying context B's identifiers, on a connection that owns A and
      nothing else:
    */
    const SMUGGLED = {
      workspaceId: "ws_enc_b",
      expectedWorkspaceId: "ws_enc_b",
      workspace: "@encb",
      workspace_id: "ws_enc_b",
      slug: "encb",
      generation: "k1",
      current: "k1",
      keys: { k1: KEY_B },
      encryptionKey: { current: "k1", keys: { k1: KEY_B } },
      startEncryptionRotation: true,
      completeEncryptionRotation: "k1",
      scope: "private",
      accessToken: OWNER_B,
    };
    const smuggledExport = await call(OWNER_A, "export_encryption_keys", { ...SMUGGLED });
    const smuggledText = textOf(smuggledExport);
    check(
      "an owner naming ANOTHER context in every argument but `context` still exports only their own",
      !smuggledExport?.isError &&
        smuggledText.includes(KEY_A) &&
        !smuggledText.includes(KEY_B) &&
        !smuggledText.includes("ws_enc_b") &&
        JSON.parse(smuggledText.slice(smuggledText.indexOf("{"))).workspace_id === "ws_enc_a",
    );

    check(
      "the export says what it means and points at the offline decryptor",
      /one-way action/.test(exportedText) && exportedText.includes("packages/encryption-decryptor"),
    );
    check(
      "...and names the one thing it does not open, rather than leaving it to be discovered",
      /locked with a passphrase is not\s+opened by this file|locked with a passphrase is not opened by this file/.test(
        exportedText.replace(/\s+/g, " "),
      ),
    );
    check(
      "the export never appears in the audit trail",
      !(await (async () => {
        const keys = [...a.objects.keys()].filter((key) => key.startsWith(".audit/"));
        const text = keys.map((key) => new TextDecoder().decode(a.objects.get(key).bytes)).join("\n");
        return text.includes(KEY_A);
      })()),
    );

    /*
      THE KEY LEAVES IN THE RESPONSE BODY AND NOWHERE ELSE.

      The audit check above covers `.audit/`. This one covers the gateway's
      own structured logs, which are the other place a value that passes
      through a request routinely ends up — `console.log` is captured for the
      length of one export and searched for the material itself. A log line is
      not a place a key can be revoked from.
    */
    const captured = [];
    const exportLogSpy = console.log;
    const exportWarnSpy = console.warn;
    const exportErrorSpy = console.error;
    console.log = (...parts) => captured.push(parts.map(String).join(" "));
    console.warn = (...parts) => captured.push(parts.map(String).join(" "));
    console.error = (...parts) => captured.push(parts.map(String).join(" "));
    let loggedExport;
    try {
      loggedExport = await call(OWNER_A, "export_encryption_keys", {});
    } finally {
      console.log = exportLogSpy;
      console.warn = exportWarnSpy;
      console.error = exportErrorSpy;
    }
    check(
      "the exported key material never reaches a log line",
      !loggedExport?.isError &&
        textOf(loggedExport).includes(KEY_A) && // it IS in the response — the check is not vacuous
        !captured.join("\n").includes(KEY_A),
    );

    /*
      THE RATE LIMIT, ASKED THE WAY AN ATTACKER WOULD.

      Three exports have happened above — the first one, the
      smuggled-argument one, and the log-capture one — so exactly two of the
      six attempts below may be accepted. The
      limit is five per rolling day per CONTEXT,
      and the three ways a caller would try to get around it are all the same
      question — is the counter attached to the session, or to the context?

        - a second call on the same connection
        - a *different* grant, a different OAuth client, a different user, on
          the same context
        - a reconnection (every `call` here is already a fresh session: this
          worker holds no per-connection state between requests, so the loop
          below is a reconnect on every iteration)

      The counter lives in the customer's own bucket, so all three meet it.
      Asserted as an exact count rather than "one of them failed", which is
      what the first version of this check measured — a limit of one and a
      limit of five both pass that.
    */
    const OWNER_A2 = "cat_test_enc_owner_a2_00000000000000";
    await controlPlane.addGrant({
      accessToken: OWNER_A2,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_a_second",
      userId: "user_enc_owner_a_second",
    });
    let accepted = 0;
    let refused = 0;
    let lastRefusal = null;
    // Alternating tokens: a second client cannot spend a budget of its own.
    for (const token of [OWNER_A, OWNER_A2, OWNER_A, OWNER_A2, OWNER_A, OWNER_A2]) {
      const attempt = await call(token, "export_encryption_keys", {});
      if (attempt?.isError) {
        refused += 1;
        lastRefusal = attempt;
      } else {
        accepted += 1;
      }
    }
    check(
      "exactly five exports per context per window are accepted, counting the ones already spent",
      accepted === 2 && refused === 4,
    );
    check(
      "a second client, a second grant and a reconnection all meet the same counter",
      lastRefusal !== null && /rate limited/.test(textOf(lastRefusal)),
    );
    check(
      "a rate-limited attempt returns no key material at all",
      !textOf(lastRefusal).includes(KEY_A),
    );

    /*
      THE COUNTER IS A NEW OBJECT IN SOMEBODY'S BUCKET, so it has to behave
      like the plumbing it claims to be: written under `.context/`, never
      listed as a note, never readable as one, and carrying nothing but two
      numbers. A counter a tool could read would leak how often the owner
      exports; a counter a tool could *write* would be a rate limit anyone
      holding a write scope could reset.
    */
    const counterKey = ".context/encryption-export-rate.json";
    const counter = JSON.parse(readA(counterKey) ?? "null");
    const listedNotes = await call(OWNER_A, "list_notes", {});
    const readCounter = await call(OWNER_A, "read_note", { path: counterKey });
    const wroteCounter = await call(OWNER_A, "write_note", {
      path: counterKey,
      content: "{\"windowStartedAt\":0,\"count\":0}",
    });
    check(
      "the export counter is plumbing: two numbers, unlisted, unreadable, unwritable",
      counter !== null &&
        Object.keys(counter).sort().join(",") === "count,windowStartedAt" &&
        !textOf(listedNotes).includes("encryption-export-rate") &&
        readCounter?.isError === true &&
        wroteCounter?.isError === true &&
        // and the refused write did not reset it
        JSON.parse(readA(counterKey)).count === counter.count,
    );

    /* -- (16) rotate_encryption_keys ------------------------------------------ */

    const teamRotate = await call(TEAM_A, "rotate_encryption_keys", {});
    check(
      "a team connection cannot see rotate_encryption_keys exists either",
      teamRotate?.isError === true && textOf(teamRotate) === "unknown tool: rotate_encryption_keys",
    );

    const keylessRotate = await call(KEYLESS, "rotate_encryption_keys", {});
    check(
      "a context with no key has nothing to rotate, and it is not a refusal",
      !keylessRotate?.isError && /nothing to rotate/.test(textOf(keylessRotate)),
    );

    // Three WORKSPACE-encrypted notes exist by this point:
    // `1-projects/vault/private-secret.md` (encrypted in section (3) and never
    // decrypted), `1-projects/conflict.md` (left encrypted by section (12)),
    // and the one section (14) re-sealed while proving the write guard.
    // `1-projects/moved-secret.md`, moved in section (6), was decrypted again
    // in section (10) and is plaintext.
    //
    // And one note that is NOT among them: `1-projects/locked.md`, the
    // passphrase-locked note from section (14), which carries a `passphrase`
    // recipient and no workspace one. The rotation walk must pass it by —
    // there is no workspace recipient in it to move, its key is not ours, and
    // the failure to avoid is a pass that counts it as a note it could not
    // place and therefore never reports itself finished. It is skipped on the
    // frontmatter marker, which `renderEncryptedNote` omits for a note with no
    // workspace recipient precisely so this walk does not go looking for a key
    // called "undefined".
    const beforeRotate = readA("1-projects/vault/private-secret.md");
    const lockedBeforeRotate = readA(LOCKED);
    const rotated = await call(OWNER_A, "rotate_encryption_keys", {});
    check(
      "rotation reports what it did and completes in one call for a small context",
      !rotated?.isError &&
        /rotation complete: k1 → k2/.test(textOf(rotated)) &&
        /3 note\(s\) re-wrapped/.test(textOf(rotated)),
    );
    check(
      "a passphrase-locked note is passed over by the walk, byte for byte, and does not stall it",
      readA(LOCKED) === lockedBeforeRotate,
    );

    const afterRotate = readA("1-projects/vault/private-secret.md");
    check(
      "the note's body ciphertext is byte-for-byte unchanged by rotation",
      isEncryptedNote(afterRotate) &&
        isEncryptedNote(beforeRotate) &&
        parseEncryptedNote(afterRotate).ct === parseEncryptedNote(beforeRotate).ct &&
        parseEncryptedNote(afterRotate).iv === parseEncryptedNote(beforeRotate).iv,
    );
    check(
      "...but its frontmatter now names the new generation",
      /context_encryption_key: ws:k2/.test(afterRotate),
    );

    const readAfterRotate = await call(OWNER_A, "read_note", {
      path: "1-projects/vault/private-secret.md",
    });
    check(
      "the rotated note still reads back to exactly its plaintext",
      !readAfterRotate?.isError && textOf(readAfterRotate).endsWith(SECRET_BODY),
    );

    // Calling the tool again with no rotation in progress starts a FRESH one
    // (k2 -> k3) — rotation has no "already rotated, do nothing" state, only
    // "a walk is in progress" or not. Both live notes move again, and the
    // walk completes in the same call for a context this small.
    const rotateAgain = await call(OWNER_A, "rotate_encryption_keys", {});
    check(
      "rotating again with no walk in progress starts and completes a fresh rotation",
      !rotateAgain?.isError &&
        /rotation complete: k2 → k3/.test(textOf(rotateAgain)) &&
        /3 note\(s\) re-wrapped/.test(textOf(rotateAgain)),
    );
    check(
      "...and the locked note is still exactly what it was, two rotations later",
      readA(LOCKED) === lockedBeforeRotate,
    );

    const auditAfterRotate = [...a.objects.keys()]
      .filter((key) => key.startsWith(".audit/"))
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "rotation is audited by generation id, never by key material",
      /rotate_encryption_keys/.test(auditAfterRotate) &&
        !auditAfterRotate.includes(KEY_A) &&
        !readA("1-projects/vault/private-secret.md").includes(KEY_A),
    );

    /*
      THE ROTATION HALF OF THE SMUGGLED-ARGUMENT ATTACK, ASKED LAST.

      The export half is above, beside the other export checks. This one has
      the sharper version of the same question and belongs here, after two
      real rotations, because it performs a third: two of the names in
      `SMUGGLED` are the literal flags `/gateway/binding` accepts
      (`startEncryptionRotation`, `completeEncryptionRotation`), so a tool
      that passed its arguments through to `store.rotateEncryptionKeys` would
      hand a caller a rotation of somebody else's workspace key — the one
      operation in this file that can strand every note in a bucket.

      Two things have to hold: B's bytes are untouched, and this call rotated
      A rather than reporting on B. The generation labels are the tell —
      A is on k3 by now, B has never rotated and is still on k1, so a call
      that answered about B would say "k1 → k2".
    */
    const bStolenBefore = readB("1-projects/stolen.md");
    const bOwnBefore = readB("1-projects/own.md");
    const smuggledRotate = await call(OWNER_A, "rotate_encryption_keys", { ...SMUGGLED });
    check(
      "a rotation named at another context in every argument rotates this one, and leaves that one's bytes alone",
      !smuggledRotate?.isError &&
        /rotation complete: k3 → k4/.test(textOf(smuggledRotate)) &&
        !textOf(smuggledRotate).includes(KEY_B) &&
        readB("1-projects/stolen.md") === bStolenBefore &&
        readB("1-projects/own.md") === bOwnBefore,
    );
  } finally {
    restore();
  }
}

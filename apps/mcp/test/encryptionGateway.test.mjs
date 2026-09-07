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
 * Three of those rows are findings about this file rather than about the
 * source.
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
import { indexableText, isEncryptedNote, parseEncryptedNote } from "../src/encryption.js";
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
      encryptionKey: { generation: "k1", dataKey: KEY_A },
    });
    controlPlane.addWorkspace("ws_enc_b", "encb", {
      provider: "r2-binding",
      bindingName: "BUCKET_B",
      capabilities: { conditionalWrite: true },
      status: "active",
      encryptionKey: { generation: "k1", dataKey: KEY_B },
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
     * but its PATH still can: MEASURED, a search for "moved" — a word that
     * appears only in `1-projects/moved-secret.md` — answered
     * "2 matching notes — the 1 best shown" with the encrypted note counted
     * and withheld.
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
  } finally {
    restore();
  }
}

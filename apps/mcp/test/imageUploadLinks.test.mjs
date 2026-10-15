/**
 * Upload links (`src/notes/imageUploads.js`): `write_note` with `upload` hands
 * an agent a curl command, the PUT stores the bytes, and `images: [{ name,
 * sha256 }]` embeds them.
 *
 * What has to hold: the ticket stores exactly the declared bytes, once, into
 * the workspace it was minted for; any other bytes, a second use, a revoked
 * grant, an oversize or non-image body all store nothing; a read-only
 * connection gets no ticket; nothing is written to a note by asking; and a
 * sha256 nobody uploaded here embeds nothing.
 *
 * Sabotage, each confirmed to fail a case here: drop `contentSha256` from the
 * open call (the other-bytes case), skip `store.put`'s leaf naming from the
 * sniffed type (the SVG case), or let `findUploadedImage` accept any hash.
 */
import { createHash } from "node:crypto";
import { check, call, contextStore, controlPlane, env, worker } from "./harness.mjs";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc0, 0x80, 0x11, 0x22, 0x33]);
const OTHER_PNG = new Uint8Array([...PNG.slice(0, 8), 0x01, 0x02]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const NOTE = "1-projects/portable/uploaded-picture.md";

const text = (result) => result?.content?.[0]?.text ?? "";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** An upload link stores a picture under its whole hash, so a lookup by hash is exact. */
const leafOf = (bytes) => `upload-${sha(bytes)}.png`;

/** The ticket and URL out of an answer's curl line, the way an agent would run it. */
function commandIn(answer) {
  const match = text(answer).match(/Authorization: Bearer ([^']+)' --data-binary @'[^']+' (\S+)/);
  return match ? { ticket: match[1], url: match[2] } : null;
}

async function put(url, ticket, body) {
  const response = await worker.fetch(
    new Request(url, { method: "PUT", headers: ticket ? { Authorization: `Bearer ${ticket}` } : {}, body }),
    env,
    { waitUntil() {} },
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function stored(leaf) {
  const object = await contextStore.get(`.context/assets/images/${leaf}`);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

async function linkFor(token, bytes, name = "shot.png") {
  return call(token, "write_note", { path: NOTE, upload: [{ name, sha256: sha(bytes), bytes: bytes.byteLength }] });
}

export async function runImageUploadLinkChecks() {
  // -- the whole road: link, PUT, embed
  const asked = await linkFor("priv-token", PNG);
  const command = commandIn(asked);
  check("write_note with upload answers with a curl command carrying a ticket", !asked?.isError && command !== null);
  check("the ticket travels in a header, never in the URL", command !== null && !command.url.includes(command.ticket));
  check("asking for a link writes no note", (await contextStore.get(NOTE)) === null);

  const sent = await put(command.url, command.ticket, PNG);
  check("the PUT stores the picture and names its leaf", sent.status === 201 && sent.body?.stored === leafOf(PNG));
  const bytes = await stored(leafOf(PNG));
  check("the bytes land in the opaque image store, byte for byte", bytes !== null && Buffer.from(bytes).equals(Buffer.from(PNG)));

  const again = await put(command.url, command.ticket, PNG);
  check("a ticket works once", again.status === 403);

  const written = await call("priv-token", "write_note", {
    path: NOTE,
    content: "# Shot\n\n![[shot.png|320]]\n",
    images: [{ name: "shot.png", sha256: sha(PNG) }],
  });
  const body = await contextStore.get(NOTE).then((object) => object?.text());
  check(
    "write_note embeds an uploaded picture by its sha256",
    !written?.isError && body?.includes(`![[${leafOf(PNG)}|320]]`) && !body?.includes("shot.png"),
  );

  // -- other bytes: refused, and the ticket survives for the right ones
  const second = commandIn(await linkFor("priv-token", OTHER_PNG));
  const wrong = await put(second.url, second.ticket, PNG);
  check("a ticket refuses bytes it was not minted for", wrong.status === 403);
  const right = await put(second.url, second.ticket, OTHER_PNG);
  check("and other bytes did not spend it", right.status === 201 && (await stored(leafOf(OTHER_PNG))) !== null);

  // -- bodies refused before the ticket is spent
  const svgTicket = commandIn(await call("priv-token", "write_note", {
    path: NOTE,
    upload: [{ name: "x.svg", sha256: sha(SVG), bytes: SVG.byteLength }],
  }));
  const svg = await put(svgTicket.url, svgTicket.ticket, SVG);
  check("an SVG is refused as a picture and stores nothing", svg.status === 415);
  const job = controlPlane.gatewayJobs.get(svgTicket.ticket);
  check("a refused body leaves its ticket unspent", job?.status === "queued");
  const big = await put(command.url, "f".repeat(64), new Uint8Array(5_000_001));
  check("a body over 5,000,000 bytes is refused", big.status === 413);
  const noTicket = await put(command.url, null, PNG);
  check("a PUT without a ticket is refused", noTicket.status === 401);
  const unknown = await put(command.url, "e".repeat(64), PNG);
  check("an unknown ticket stores nothing", unknown.status === 403);
  const get = await worker.fetch(new Request(command.url), env, { waitUntil() {} });
  check("the upload address takes PUT only", get.status === 405);

  // -- revocation between asking and sending
  const revokedFor = new Uint8Array([...PNG, 0x44]);
  const pending = commandIn(await linkFor("team-token", revokedFor));
  check("an editor gets an upload link", pending !== null);
  const editorGrant = [...controlPlane.grants.values()].find((grant) => grant.clientId === "mcp_client_team-token");
  editorGrant.status = "revoked";
  const afterRevoke = await put(pending.url, pending.ticket, revokedFor);
  editorGrant.status = "active";
  check("a revoked grant's ticket stores nothing", afterRevoke.status === 403 && (await stored(leafOf(revokedFor))) === null);

  // -- who may ask, and what may be asked
  const readOnly = await linkFor("readonly-token", PNG);
  check("a read-only connection gets no upload link", readOnly?.isError === true && commandIn(readOnly) === null);
  const badHash = await call("priv-token", "write_note", { path: NOTE, upload: [{ name: "a.png", sha256: "abc", bytes: 10 }] });
  check("a malformed sha256 is refused with how to get one", badHash?.isError && /sha256sum/.test(text(badHash)));
  const quoted = await call("priv-token", "write_note", {
    path: NOTE,
    upload: [{ name: "a'; rm -rf ~; '.png", sha256: sha(PNG), bytes: PNG.byteLength }],
  });
  check("a file name that would break out of the shell quoting is refused", quoted?.isError === true);

  // -- a near miss is a miss: the whole hash names the picture, not a prefix of it
  const nearMiss = await call("priv-token", "write_note", {
    path: "1-projects/portable/near-miss.md",
    content: "# Near\n\n![[near.png]]\n",
    // The stored picture's first 16 hex characters, and 48 that are not its own.
    images: [{ name: "near.png", sha256: sha(PNG).slice(0, 16) + "f".repeat(48) }],
  });
  check(
    "a sha256 sharing only the stored picture's first 16 hex characters is refused",
    nearMiss?.isError === true && (await contextStore.get("1-projects/portable/near-miss.md")) === null,
  );

  // -- a hash nobody uploaded here embeds nothing
  const never = await call("priv-token", "write_note", {
    path: "1-projects/portable/never-uploaded.md",
    content: "# Nothing\n\n![[ghost.png]]\n",
    images: [{ name: "ghost.png", sha256: "c".repeat(64) }],
  });
  check(
    "a sha256 not uploaded to this workspace is refused, and the note is not written",
    never?.isError === true && (await contextStore.get("1-projects/portable/never-uploaded.md")) === null,
  );
}

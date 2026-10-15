/**
 * Upload links: how an agent that holds a picture as a FILE puts it in a note.
 *
 * `write_note`'s `images` takes base64 or an https URL. Base64 means the model
 * reads the whole picture out as text, which a real screenshot makes too long
 * to send; a URL means the picture must already be public somewhere. An agent
 * with a shell (Claude Code, Codex) has the file on disk and can run `curl`, so
 * this is the third way, in three steps:
 *
 *  1. `write_note` with `upload: [{ name, sha256, bytes }]` mints one ticket per
 *     picture through the control plane (`/gateway/jobs/create`, kind
 *     `image_upload`) and answers with a `curl` line for each. Nothing is
 *     written.
 *  2. The agent runs the line: `PUT /api/image-upload` with the ticket in the
 *     `Authorization` header and the file as the body. This route hashes the
 *     body, spends the ticket for exactly that hash (`/gateway/jobs/open` with
 *     `contentSha256`), and stores the bytes in the opaque image store under
 *     the same content-hashed leaf an attached image gets.
 *  3. `write_note` with `images: [{ name, sha256 }]` embeds it, exactly as if
 *     the bytes had come in the call (`notes/uploadedImages.js`).
 *
 * **What the ticket is.** Not a credential to anything a person owns. It is
 * minted only by a live grant that can write the context (owner or editor,
 * `context:write`), and it opens that one context's bucket once, within ten
 * minutes, for exactly the bytes whose SHA-256 and length the agent declared,
 * while the grant is still live and the person can still write there. Somebody
 * who learns it can store the picture the agent was about to store, unseen and
 * unreferenced, and nothing else; with any other bytes the control plane opens
 * nothing and the ticket stays unspent. It travels in a header, never the URL,
 * so it is not in a log line or a referrer either. See
 * `docs/decisions/gateway-protocol/image-upload-links.md`.
 *
 * Nothing about the bytes is trusted until they are here: the type is sniffed
 * (SVG and HTML are refused, as on every way in), and the length and hash are
 * measured on what arrived.
 */

import { IMAGE_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { sniffImageType } from "../../../../packages/shared/src/remoteImage.cjs";
import { storeForOpenedBinding } from "../session.js";
import { createControlPlane } from "../controlPlane.js";
import { json } from "../http/responses.js";
import { imageRefFor } from "../tools/readImage.js";
import { MAX_IMAGES_PER_WRITE, MAX_UPLOADED_IMAGE_BYTES, SHA256_PATTERN, sha256Hex, uploadLeaf } from "./uploadedImages.js";

export const IMAGE_UPLOAD_PATH = "/api/image-upload";

/** How long a ticket lasts: the control plane's `IMAGE_UPLOAD_TTL_MS`. Said in the answer, enforced there. */
const TICKET_MINUTES = 10;

const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Give a session's store the one thing step 1 needs: a ticket minted with
 * that session's own token, for the workspace this store reaches. The token
 * stays here, off the store's enumerable fields and out of every tool.
 */
export function attachImageUploads(store, session, controlPlane, origin) {
  if (typeof controlPlane?.createGatewayJob !== "function") return;
  Object.defineProperty(store, "mintImageUpload", {
    value: async ({ sha256, bytes }) => {
      const ticket = await controlPlane.createGatewayJob(session.accessToken, session.workspaceId, {
        kind: "image_upload",
        sha256,
        bytes,
      });
      return ticket === null ? null : { ticket, url: `${origin}${IMAGE_UPLOAD_PATH}` };
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

function fileNameOk(name) {
  return typeof name === "string" && name.trim() !== "" && name.length <= 200 && !/[\[\]|\r\n#'"\\]/.test(name);
}

/** Step 1: `write_note` with `upload`. Mints, answers with the commands, writes nothing. */
export async function toolImageUploadLinks(store, args) {
  const uploads = args.upload;
  const refuse = (text) => ({ content: [{ type: "text", text }], isError: true });
  if (!Array.isArray(uploads) || uploads.length === 0) return refuse("upload must be a list of { name, sha256, bytes }");
  if (uploads.length > MAX_IMAGES_PER_WRITE) return refuse(`at most ${MAX_IMAGES_PER_WRITE} upload links per write_note`);
  if (typeof store.mintImageUpload !== "function") return refuse("upload links are unavailable on this deployment");
  const names = new Set();
  for (const [index, upload] of uploads.entries()) {
    const label = `upload[${index}]`;
    if (!upload || typeof upload !== "object") return refuse(`${label} must be an object`);
    if (!fileNameOk(upload.name)) return refuse(`${label}: name must be the picture's file name, e.g. chart.png`);
    if (names.has(upload.name)) return refuse(`${label}: two uploads are named ${upload.name}`);
    names.add(upload.name);
    if (typeof upload.sha256 !== "string" || !SHA256_PATTERN.test(upload.sha256.toLowerCase())) {
      return refuse(`${label}: sha256 must be the file's SHA-256 in hex (sha256sum or shasum -a 256 prints it)`);
    }
    if (!Number.isInteger(upload.bytes) || upload.bytes < 1 || upload.bytes > MAX_UPLOADED_IMAGE_BYTES) {
      return refuse(`${label}: bytes must be the file's size, at most ${MAX_UPLOADED_IMAGE_BYTES}`);
    }
  }
  const lines = [];
  for (const upload of uploads) {
    const sha256 = upload.sha256.toLowerCase();
    const minted = await store.mintImageUpload({ sha256, bytes: upload.bytes });
    if (minted === null) return refuse("permission denied: this connection cannot add pictures to this workspace");
    lines.push(
      `${upload.name}:\n  curl -sS --fail-with-body -X PUT -H 'Authorization: Bearer ${minted.ticket}' ` +
        `--data-binary @'${upload.name.trim()}' ${minted.url}`,
    );
  }
  const embed = uploads.map((upload) => `{ name: "${upload.name.trim()}", sha256: "${upload.sha256.toLowerCase()}" }`);
  return {
    content: [
      {
        type: "text",
        text:
          `Nothing written yet. Run each command from the folder that holds the file (each works once, for ${TICKET_MINUTES} minutes, and only for the exact file you hashed):\n\n` +
          `${lines.join("\n")}\n\n` +
          `Then call write_note with path "${args.path}", your content embedding each picture by name (![[${uploads[0].name.trim()}]]), ` +
          `and images: [${embed.join(", ")}].`,
      },
    ],
  };
}

/** The body, or null past `max` bytes: counted as it arrives, never buffered past the ceiling. */
async function readCapped(request, max) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Step 2: `PUT /api/image-upload`. Every refusal before the ticket is spent
 * says only what is wrong with the request; every refusal after names no
 * workspace, key or provider text.
 */
export async function handleImageUpload(request, env, deps = {}) {
  if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "PUT" } });
  const ticket = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "")?.[1] ?? "";
  if (!TICKET_PATTERN.test(ticket)) return json({ error: "send the upload ticket as Authorization: Bearer <ticket>" }, 401);
  const bytes = await readCapped(request, MAX_UPLOADED_IMAGE_BYTES);
  if (bytes === null) return json({ error: `the picture is larger than ${MAX_UPLOADED_IMAGE_BYTES} bytes` }, 413);
  if (bytes.byteLength === 0) return json({ error: "the body is empty; send the file with --data-binary @file" }, 400);
  const type = sniffImageType(bytes);
  if (!type) return json({ error: "not a PNG, JPEG, GIF, WebP or HEIC image (SVG is never stored)" }, 415);
  const sha256 = await sha256Hex(bytes);
  const leaf = uploadLeaf(sha256, type.extension);
  if (imageRefFor(leaf)?.mimeType !== type.contentType) return json({ error: "could not name the picture" }, 415);

  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  let opened;
  try {
    opened = await controlPlane.openGatewayJob(ticket, { contentSha256: sha256 });
  } catch {
    return json({ error: "uploads are unavailable right now; try again" }, 503);
  }
  // One answer for unknown, expired, spent, revoked and wrong-bytes alike.
  const refused = { error: "this ticket does not take this file: it expired, was used, or was minted for other bytes" };
  if (opened === null) return json(refused, 403);
  if (typeof opened.retryAfterMs === "number") return json({ error: "this ticket's upload is already under way" }, 409);
  const job = opened.job;
  if (job?.kind !== "image_upload" || job.imageSha256 !== sha256 || job.imageBytes !== bytes.byteLength) {
    await controlPlane.reportGatewayJob(ticket, { status: "failed", error: "upload did not match its ticket" }).catch(() => {});
    return json(refused, 403);
  }
  try {
    const store = (deps.storeFor ?? storeForOpenedBinding)(opened, job.workspaceId, env);
    await store.put(IMAGE_PREFIX + leaf, bytes, { contentType: type.contentType });
  } catch {
    console.error("image_upload.store_failed", { workspaceId: job.workspaceId, grantId: job.grantId });
    await controlPlane.reportGatewayJob(ticket, { status: "failed", error: "storage unavailable" }).catch(() => {});
    return json({ error: "the picture could not be stored; ask write_note for a new link" }, 502);
  }
  await controlPlane.reportGatewayJob(ticket, { status: "complete" }).catch(() => {});
  console.log("image_upload.stored", { workspaceId: job.workspaceId, grantId: job.grantId, bytes: bytes.byteLength });
  return json({ stored: leaf, sha256, bytes: bytes.byteLength }, 201);
}

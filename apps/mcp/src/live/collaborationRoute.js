/**
 * `/collaboration/...` — the HTTP half of shared editing: read the Yjs
 * document, commit an update, all behind the caller's session and `canSee`.
 */

import { announceCommittedToPresence } from "./presence.js";
import { byteSize } from "../notes/format.js";
import { canSee, effectiveVisibility, isPlumbing } from "../privacy/engine.js";
import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  commitUpdate as commitCollaborationUpdate,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
} from "@context/collaboration";
import {
  collaborationErrorResponse,
  collaborationHead,
  collaborationIdentityFromRequest,
  MAX_COLLABORATION_NOTE_BYTES,
  MAX_COLLABORATION_REQUEST_BYTES,
  MAX_COLLABORATION_UPDATE_CHARS,
  readBoundedRequestBytes,
} from "./collaborationHttp.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { hasScope, SCOPE_READ, SCOPE_WRITE } from "../session.js";
import { json } from "../http/responses.js";
import { loadPrivacyState } from "../privacy/state.js";
import { normalizePath } from "../notes/paths.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { projectWrittenNoteAfterResponse } from "../search/writeProjection.js";
import { recordChange } from "../activity/record.js";

export async function handleCollaboration(request, store, session, origin) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!hasScope(session, SCOPE_READ)) return json({ error: "forbidden" }, 403);

  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_COLLABORATION_REQUEST_BYTES) {
    return json({ error: "request_too_large" }, 413);
  }

  let body;
  try {
    const bounded = await readBoundedRequestBytes(request, MAX_COLLABORATION_REQUEST_BYTES);
    if (bounded === null) return json({ error: "request_too_large" }, 413);
    body = JSON.parse(new TextDecoder().decode(bounded));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_request" }, 400);
  }
  const keys = Object.keys(body);
  if (keys.some((key) => !["path", "documentId", "update", "replacement"].includes(key))) {
    return json({ error: "invalid_request" }, 400);
  }
  const path = normalizePath(body.path);
  if (!path || !path.endsWith(".md") || isPlumbing(path)) {
    return json({ error: "invalid_path" }, 400);
  }

  const hasDocumentId = Object.prototype.hasOwnProperty.call(body, "documentId");
  const hasUpdate = Object.prototype.hasOwnProperty.call(body, "update");
  const hasReplacement = Object.prototype.hasOwnProperty.call(body, "replacement");
  const isUpdate = hasDocumentId || hasUpdate || hasReplacement;
  const isReplacement = hasReplacement && !hasDocumentId && !hasUpdate;
  if (hasReplacement && (!isReplacement || body.replacement === null ||
      typeof body.replacement !== "object" || Array.isArray(body.replacement) ||
      Object.keys(body.replacement).some((key) => !["expectedEtag", "text"].includes(key)) ||
      typeof body.replacement.expectedEtag !== "string" ||
      body.replacement.expectedEtag.length === 0 || body.replacement.expectedEtag.length > 512 ||
      typeof body.replacement.text !== "string" ||
      new TextEncoder().encode(body.replacement.text).byteLength > MAX_COLLABORATION_NOTE_BYTES)) {
    return json({ error: "invalid_replacement" }, 400);
  }
  if (isUpdate) {
    if (!isReplacement && (!hasDocumentId || !hasUpdate || typeof body.documentId !== "string" ||
        body.documentId.length === 0 || body.documentId.length > 256 ||
        typeof body.update !== "string" || body.update.length === 0 ||
        body.update.length > MAX_COLLABORATION_UPDATE_CHARS ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.update))) {
      return json({ error: "invalid_update" }, 400);
    }
    if (!hasScope(session, SCOPE_WRITE)) {
      return json({ error: "forbidden" }, 403);
    }
  }

  const privacy = await loadPrivacyState(store);
  if (privacy.error) return json({ error: "not_found" }, 404);
  const { rules, overrides } = privacy;
  // Probe every request before reading content, including hidden and missing
  // paths.  A collaboration read must never become an existence oracle.
  let effectivePath = path;
  let visible = canSee(effectivePath, session.scope, rules, overrides, session.grantedGroups);
  let present = await probeWithLegacyFallback(store, effectivePath);

  if (!visible) return json({ error: "not_found" }, 404);

  // The metadata probe above is deliberately safe before authorization, but a
  // logical-delete marker is still physically present. Resolve the authorized
  // logical object before deciding whether a moved head may forward this
  // request. Otherwise a path-only reconnect sees the marker, stops at the old
  // path, and returns 404 instead of carrying its offline edits to the moved
  // document. Keep the fetched object so the ordinary path does not download
  // the same note twice.
  let stored = present ? await getWithLegacyFallback(store, effectivePath) : null;
  if (present && !stored) present = false;

  // A moved collaborative head remains the authority for an offline client
  // holding the old path. An offline filesystem may recreate raw bytes at the
  // old source before it can deliver its pending update, so an update carrying
  // the moved document's identity follows the head even when raw bytes exist.
  // A plain read of a deliberately recreated source still starts a new
  // generation there.
  // Hidden/private destinations and internal trash are deliberately terminal
  // 404s, so this cannot become a path or trash existence oracle.
  if (collaborationSupported(store)) {
    const requestedDocumentId = collaborationIdentityFromRequest(body);
    const visited = new Set([effectivePath]);
    for (let hop = 0; hop < 8; hop += 1) {
      let destination = null;
      const head = await collaborationHead(store, effectivePath);
      if (head?.status === "moved" && (!present || requestedDocumentId === head.documentId)) {
        destination = normalizePath(head.destination);
      }
      if (!destination && present) break;
      try {
        if (!destination) {
          await readCollaborationDocument(store, effectivePath);
          present = true;
          break;
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
        destination = error && typeof error === "object" && "destination" in error
          ? normalizePath(error.destination)
          : null;
        if (code !== "MOVED") break;
      }
      if (!destination || visited.has(destination) || !destination.endsWith(".md") ||
          isPlumbing(destination) ||
          !canSee(destination, session.scope, rules, overrides, session.grantedGroups)) {
        break;
      }
      {
        visited.add(destination);
        effectivePath = destination;
        visible = true;
        // A moved destination need not have raw Markdown: it may itself be an
        // alias to a later head. Keep following the collaboration identity
        // until a raw destination exists or a live engine head answers.
        present = await probeWithLegacyFallback(store, destination);
        stored = present ? await getWithLegacyFallback(store, destination) : null;
        if (present && !stored) present = false;
      }
    }
  }
  if (!visible || !present) return json({ error: "not_found" }, 404);

  // Check the stored bytes before the engine initializes a document. Encrypted
  // and drawing notes stay outside this plaintext collaboration capability.
  stored ||= await getWithLegacyFallback(store, effectivePath);
  if (!stored) return json({ error: "not_found" }, 404);
  const storedText = await stored.text();
  if (!collaborationEligible(effectivePath, storedText) ||
      new TextEncoder().encode(storedText).byteLength > MAX_COLLABORATION_NOTE_BYTES) {
    return json({ error: "unsupported_note" }, 409);
  }

  if (!collaborationSupported(store)) {
    return json({ error: "collaboration_unavailable" }, 501);
  }

  // An update must go directly to commitUpdate. A preceding read can report
  // DEPENDENCY_PENDING for an out-of-order offline operation; reading that
  // state here would reject the corrective update that would satisfy the
  // dependency and permanently strand the document. The raw note checks above
  // already establish eligibility before the engine sees the request.
  if (!isUpdate) {
    let current;
    try {
      current = await readCollaborationDocument(store, effectivePath);
    } catch {
      return json({ error: "collaboration_unavailable" }, 503);
    }
    if (!collaborationEligible(path, current.text) ||
        new TextEncoder().encode(current.text).byteLength > MAX_COLLABORATION_NOTE_BYTES) {
      return json({ error: "unsupported_note" }, 409);
    }
    return json(current);
  }

  let result;
  try {
    result = isReplacement
      ? await replaceCollaborationText(store, effectivePath, {
          expectedEtag: body.replacement.expectedEtag,
          text: body.replacement.text,
        })
      : await commitCollaborationUpdate(store, effectivePath, {
          documentId: body.documentId,
          update: body.update,
        });
  } catch (error) {
    return collaborationErrorResponse(error);
  }
  if (typeof result?.text !== "string" ||
      new TextEncoder().encode(result.text).byteLength > MAX_COLLABORATION_NOTE_BYTES) {
    return json({ error: "note_too_large" }, 413);
  }
  // A dependency-only retry or an idempotent update may return the current
  // snapshot unchanged. Those are successful protocol operations, but they
  // are not user-visible note changes and must not manufacture activity,
  // audit, or search-projection work.
  if (result.text !== storedText) {
    const visibility = effectiveVisibility(effectivePath, rules, overrides);
    await recordChange(store, "update_note", session.scope, [effectivePath], {
      etag: result.etag,
      visibility,
      team_visible: visibility === "team",
      content_bytes: byteSize(result.text),
      previous_bytes: byteSize(storedText),
    });
    await projectWrittenNoteAfterResponse(store, {
      path: effectivePath,
      content: result.text,
      version: result.etag,
      visibility,
    });
  }
  await announceCommittedToPresence(store, effectivePath, result);
  return json(result);
}

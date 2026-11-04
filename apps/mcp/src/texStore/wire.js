/**
 * How the gateway talks to a Tex store Durable Object (`texStore.js`): one
 * `fetch` per call, the call in a header and a body's bytes as the body, so a
 * note is never base64'd or JSON-escaped on the way.
 *
 * `serveTexStore` is the object's side, `texBucket` the gateway's: an object
 * shaped like an R2 bucket binding, so `new R2Store(texBucket(stub))` is the
 * gateway's ordinary store over the Durable Object (`store/r2.js`). `texTimers`
 * is the gateway's client for the routine alarms (`alarms.js`).
 */

import { TexObjectRefused } from "./objects.js";
import { withHistoryView } from "./historyView.js";
import { objectByName } from "../objectPlace.js";
import { OWNER_HEADER, placedName } from "./move.js";
import { mergedName } from "./merge.js";
import { DESK_LEDGER, readDesk } from "./desk.js";
import { R2Store } from "../store/r2.js";

const CALL = "x-tex-call";
const META = "x-tex-meta";
const ORIGIN = "https://tex-store.internal";

/**
 * The Durable Object a person's (`person`: their workspace id) or a group
 * chat's (`chat`: its id) Tex notes live in, with every call naming its owner.
 *
 * A person's is their personal workspace's own object (`workspace:<id>`,
 * `workspaceStore/texHost.js`; decided by the owner, 2026-11-02: one object
 * for the workspace and its Tex), whose first Tex call copies in the store
 * they had before (`merge.js`). A group chat's is its own Tex store, placed in
 * eastern North America (`placedName`), whose first call copies in the store
 * under the old name (`move.js`). A deployment without workspace objects keeps
 * a person's in a Tex store too. `null` without the binding.
 */
export function texStoreStub(env, owner) {
  const name = ownerName(owner);
  const workspaces = env?.WORKSPACE_STORE;
  const person = typeof owner?.person === "string" && workspaces && typeof workspaces.idFromName === "function";
  const namespace = person ? workspaces : env?.TEX_STORE;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  const stub = objectByName(namespace, person ? mergedName(name) : placedName(name));
  return {
    fetch(request) {
      request.headers.set(OWNER_HEADER, name);
      return stub.fetch(request);
    },
  };
}

/** The one name per owner. Exported so a test can pin that two owners never share one. */
export function ownerName(owner) {
  if (typeof owner?.person === "string" && owner.person !== "" && owner.chat === undefined) return `person:${owner.person}`;
  if (typeof owner?.chat === "string" && owner.chat !== "" && owner.person === undefined) return `chat:${owner.chat}`;
  throw new TypeError("a Tex store belongs to one person or one group chat");
}

const pack = (value) => encodeURIComponent(JSON.stringify(value ?? null));
const unpack = (value) => (value ? JSON.parse(decodeURIComponent(value)) : null);

/** What a page shows from a chat's notes: About, routines and check-ins are all notes. */
const NOTE_SECTIONS = Object.freeze(["about", "routines", "checkins"]);
/** A note's text, not the object's own bookkeeping (`state/`): only those change what the page shows. */
const touchesNotes = (key) => typeof key === "string" && key.startsWith("notes/");

const unknownOp = () => Response.json({ error: "unknown_op" }, { status: 400 });

/**
 * The Durable Object's answer to one call. `objects` is `texObjects(sql)`,
 * built once per object. `timers` is the object's routine alarms
 * (`{schedule(alarm), cancel(id)}`, `texStore.js`); without it the alarm
 * calls are unknown.
 */
export async function serveTexStore(stored, request, timers = null, live = null) {
  // The chat's history file is answered from its ledger, never kept (`historyView.js`).
  const objects = withHistoryView(stored);
  let call;
  try {
    call = unpack(request.headers.get(CALL));
  } catch {
    return Response.json({ error: "bad_call" }, { status: 400 });
  }
  try {
    switch (call?.op) {
      case "schedule": {
        if (!timers) return unknownOp();
        // The alarm rides in the body, so a payload never has to fit a header.
        let alarm;
        try {
          alarm = JSON.parse(await request.text());
        } catch {
          throw new TexObjectRefused("not an alarm");
        }
        await timers.schedule(alarm);
        return Response.json({ ok: true });
      }
      case "cancel":
        if (!timers) return unknownOp();
        await timers.cancel(call.id);
        return Response.json({ ok: true });
      case "head":
        return new Response(null, { headers: { [META]: pack(objects.head(call.key)) } });
      case "get": {
        const found = objects.get(call.key, call.options ?? {});
        if (found === null || found.body === undefined) return new Response(null, { headers: { [META]: pack(found) } });
        const { body, ...meta } = found;
        // Said in the call, not read off the response: an empty note's response may carry no body at all.
        return new Response(body, { headers: { [META]: pack({ ...meta, hasBody: true }) } });
      }
      case "put": {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const written = await objects.put(call.key, bytes, call.options ?? {});
        if (written !== null && touchesNotes(call.key)) live?.changed(NOTE_SECTIONS);
        return new Response(null, { headers: { [META]: pack(written) } });
      }
      case "delete":
        objects.delete(call.keys);
        if ((Array.isArray(call.keys) ? call.keys : [call.keys]).some(touchesNotes)) live?.changed(NOTE_SECTIONS);
        return Response.json({ ok: true });
      // The chat's Tex page: views of its one log (`pageRecords.js`), empty until the log provides them.
      case "page_list":
        if (!objects.records) return Response.json({ items: [], count: 0 });
        return Response.json({
          ...objects.records.list(call.kind, { chat: call.chat ?? undefined, limit: call.limit, cursor: call.cursor, since: call.since }),
          ...(call.kind === "mailcheck" ? { waiting: objects.records.waiting(call.chat ?? undefined) } : {}),
        });
      case "page_poke":
        live?.changed(Array.isArray(call.sections) ? call.sections : []);
        return Response.json({ ok: true });
      case "list":
        return Response.json(objects.list(call.options ?? {}));
      case "desk":
        return Response.json({ ...readDesk(objects), ...(objects.ledger ? { ledger: objects.ledger.read(DESK_LEDGER.chat, DESK_LEDGER.options) } : {}) });
      case "wipe":
        objects.wipe();
        objects.ledger?.wipe();
        return Response.json({ ok: true });
      case "ledger_append":
      case "ledger_prepend": {
        if (!objects.ledger) return unknownOp();
        // The entries ride in the body, so a long tool result never has to fit a header.
        let entries;
        try {
          entries = JSON.parse(await request.text());
        } catch {
          throw new TexObjectRefused("not ledger entries");
        }
        const added = call.op === "ledger_prepend" ? objects.ledger.prepend(call.chat, entries) : objects.ledger.append(call.chat, entries);
        if (added.added > 0) objects.ledgerChanged?.(added.kinds);
        return Response.json(added);
      }
      case "ledger_read":
        if (!objects.ledger) return unknownOp();
        return Response.json(objects.ledger.read(call.chat, call.options ?? {}));
      case "ledger_oldest":
        if (!objects.ledger) return unknownOp();
        return Response.json({ oldest: objects.ledger.oldest(call.chat) });
      case "ledger_chats":
        if (!objects.ledger) return unknownOp();
        return Response.json({ chats: objects.ledger.chats() });
      default:
        return unknownOp();
    }
  } catch (error) {
    if (error instanceof TexObjectRefused) return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
}

/** A stored object as R2 hands one back: `uploaded` a Date, a quoted `httpEtag`, and the body readers when it has one. */
export function r2Shaped(meta, bytes) {
  if (meta === null) return null;
  const object = { ...meta, uploaded: new Date(meta.uploaded), httpEtag: `"${meta.etag}"`, version: meta.etag };
  if (bytes === undefined) return object;
  let used = false;
  const take = () => {
    if (used) throw new TypeError("body already read");
    used = true;
    return bytes;
  };
  // Defined, not assigned: assigning would read the `body` getter and spend the body.
  Object.defineProperties(object, {
    body: { enumerable: true, get: () => new Response(take()).body },
    bodyUsed: { enumerable: true, get: () => used },
  });
  return Object.assign(object, {
    async arrayBuffer() {
      const view = take();
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    },
    async text() {
      return new TextDecoder().decode(take());
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(take()));
    },
    async blob() {
      return new Blob([take()]);
    },
  });
}

async function wholeBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // A stream or a Blob: read once, whole, as the object keeps it.
  return new Uint8Array(await new Response(value).arrayBuffer());
}

/**
 * An R2-bucket-shaped client over a Tex store Durable Object's stub.
 *
 * @param {{fetch: (request: Request) => Promise<Response>}} stub
 */
export function texBucket(stub) {
  const call = (op, fields, body) => callTexStore(stub, op, fields, body);
  return {
    async head(key) {
      return r2Shaped(unpack((await call("head", { key })).headers.get(META)), undefined);
    },
    async get(key, options = {}) {
      const response = await call("get", { key, options: { onlyIf: options.onlyIf, range: options.range } });
      const answer = unpack(response.headers.get(META));
      if (answer === null) return null;
      const { hasBody, ...meta } = answer;
      // A failed `onlyIf` answers metadata alone, as R2 does.
      if (hasBody !== true) return r2Shaped(meta, undefined);
      return r2Shaped(meta, new Uint8Array(await response.arrayBuffer()));
    },
    async put(key, value, options = {}) {
      const bytes = await wholeBytes(value);
      const fields = { key, options: { onlyIf: options.onlyIf, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata } };
      return r2Shaped(unpack((await call("put", fields, bytes)).headers.get(META)), undefined);
    },
    async delete(keys) {
      await call("delete", { keys });
    },
    async list(options = {}) {
      const page = await (await call("list", { options })).json();
      return { ...page, objects: page.objects.map((meta) => r2Shaped(meta, undefined)) };
    },
    /** A person's texted turn's reads, in one call (`desk.js`): `{history, notes, ledger}`. */
    async desk() {
      return await (await call("desk")).json();
    },
    /** Add entries to a chat's ledger (`ledger.js`): `{added, seq, kinds}`. */
    async ledgerAppend(chat, entries) {
      return await (await call("ledger_append", { chat }, new TextEncoder().encode(JSON.stringify(entries)))).json();
    },
    /** Entries put before everything a chat's ledger holds (`ledger.js` `prepend`): `{added, kinds}`. */
    async ledgerPrepend(chat, entries) {
      return await (await call("ledger_prepend", { chat }, new TextEncoder().encode(JSON.stringify(entries)))).json();
    },
    /** A chat's oldest ledger entry, `{id, at}`, or null. */
    async ledgerOldest(chat) {
      return (await (await call("ledger_oldest", { chat })).json()).oldest;
    },
    /** A chat's ledger as one document, `{manifest, entries, next?|before?}` (`ledger.js` `read`). */
    async ledgerRead(chat, options = {}) {
      return await (await call("ledger_read", { chat, options })).json();
    },
    /** The chats this object keeps a ledger for, each a manifest. */
    async ledgerChats() {
      return (await (await call("ledger_chats")).json()).chats;
    },
    /** Everything in this Durable Object removed: an account, a phone link or a group chat ending. */
    async wipe() {
      await call("wipe");
    },
  };
}

/** One call to the object: its answer, or a refusal as `TexObjectRefused`. */
export async function callTexStore(stub, op, fields = {}, body = undefined) {
  const response = await stub.fetch(
    new Request(`${ORIGIN}/${op}`, { method: "POST", headers: { [CALL]: pack({ op, ...fields }) }, body }),
  );
  if (response.status === 422) {
    const { message } = await response.json();
    throw new TexObjectRefused(message);
  }
  if (!response.ok) throw new Error(`Tex store ${op} failed (${response.status})`);
  return response;
}

/**
 * The gateway's client for a Tex store's routine alarms, over the same stub:
 * `schedule({id, at, payload})` sets one (replacing the id's), `cancel(id)`
 * removes one. Each re-arms the object's alarm (`texStore.js`).
 */
export function texTimers(stub) {
  return {
    async schedule(alarm) {
      await callTexStore(stub, "schedule", {}, new TextEncoder().encode(JSON.stringify(alarm ?? null)));
    },
    async cancel(id) {
      await callTexStore(stub, "cancel", { id });
    },
  };
}

/** A Tex object's store over its bucket-shaped client: notes as R2, and the desk and the chat ledgers beside them. */
export function texBucketStore(bucket) {
  return Object.assign(new R2Store(bucket), {
    desk: () => bucket.desk(),
    ledger: { append: (chat, entries) => bucket.ledgerAppend(chat, entries), read: (chat, options) => bucket.ledgerRead(chat, options), chats: () => bucket.ledgerChats(), prepend: (chat, entries) => bucket.ledgerPrepend(chat, entries), oldest: (chat) => bucket.ledgerOldest(chat) },
  });
}

/**
 * The store over an owner's object, from inside the gateway: `owner` is
 * `person:<workspaceId>` or `chat:<chatId>`, as a Tex key names it
 * (`store/texRouting.js`, which has already checked it is this workspace's).
 * `null` without the binding.
 */
export function gatewayTexStore(env) {
  return (owner) => {
    const cut = owner.indexOf(":");
    const stub = texStoreStub(env, { [owner.slice(0, cut)]: owner.slice(cut + 1) });
    if (stub === null) return null;
    const bucket = texBucket(stub);
    // The store, and the desk beside it: one call for what a texted turn reads first (`desk.js`).
    return texBucketStore(bucket);
  };
}

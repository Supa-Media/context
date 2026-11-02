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
import { objectByName } from "../objectPlace.js";
import { OWNER_HEADER, placedName } from "./move.js";
import { readDesk } from "./desk.js";
import { R2Store } from "../store/r2.js";

const CALL = "x-tex-call";
const META = "x-tex-meta";
const ORIGIN = "https://tex-store.internal";

/**
 * The Durable Object a person's (`person`: their workspace id) or a group
 * chat's (`chat`: its id) Tex notes live in: the one placed in eastern North
 * America (`placedName`), with every call naming its owner, so the first one
 * can copy in the store the owner had under the old name (`move.js`). `null`
 * without the binding.
 */
export function texStoreStub(env, owner) {
  const namespace = env?.TEX_STORE;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  const name = ownerName(owner);
  const stub = objectByName(namespace, placedName(name));
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

const unknownOp = () => Response.json({ error: "unknown_op" }, { status: 400 });

/**
 * The Durable Object's answer to one call. `objects` is `texObjects(sql)`,
 * built once per object. `timers` is the object's routine alarms
 * (`{schedule(alarm), cancel(id)}`, `texStore.js`); without it the alarm
 * calls are unknown.
 */
export async function serveTexStore(objects, request, timers = null) {
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
        return new Response(null, { headers: { [META]: pack(await objects.put(call.key, bytes, call.options ?? {})) } });
      }
      case "delete":
        objects.delete(call.keys);
        return Response.json({ ok: true });
      case "list":
        return Response.json(objects.list(call.options ?? {}));
      case "desk":
        return Response.json(readDesk(objects));
      case "wipe":
        objects.wipe();
        return Response.json({ ok: true });
      default:
        return unknownOp();
    }
  } catch (error) {
    if (error instanceof TexObjectRefused) return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
}

/** A stored object as R2 hands one back: `uploaded` a Date, a quoted `httpEtag`, and the body readers when it has one. */
function r2Shaped(meta, bytes) {
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
    /** A person's texted turn's reads, in one call (`desk.js`): `{history, notes}`. */
    async desk() {
      return await (await call("desk")).json();
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
    return Object.assign(new R2Store(bucket), { desk: () => bucket.desk() });
  };
}

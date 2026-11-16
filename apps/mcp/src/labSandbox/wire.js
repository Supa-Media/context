/**
 * A test chat's view of the real workspace and Tex objects: read through, written aside (Dev2, 2026-11-16; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * A test turn's env carries `sandboxNamespace(env.WORKSPACE_STORE, gate)` and the same over `env.TEX_STORE` in place of
 * the real bindings, so every call a turn makes to an object, by any code path, passes `sandboxedFetch` first. Both
 * objects speak one wire (`texStore/wire.js` `callTexStore`): the call in the `x-tex-call` header, a body's bytes as the
 * body. Each op is decided here by name, deny by default:
 *
 *  - a read (`READ_OPS`, `wsRead`) goes to the real object, except a key this test chat changed, which is answered from
 *    the overlay (`kv`), and the test chat's own ledger, which is the sandbox's (copied from the real one at open);
 *  - a put or delete of a key lands in the overlay, and is said in `writes`;
 *  - an alarm, a lock, a page push answers as done and is said in `writes` (an alarm never arms);
 *  - every other op, a `ws.*` write or anything unknown, is refused with the object's own refusal (422) and said in
 *    `writes`. Nothing but a read ever reaches the real object.
 */

import { DESK_LEDGER } from "../texStore/desk.js";
import { objectByName, objectIdOf } from "../objectPlace.js";

const CALL = "x-tex-call";
const META = "x-tex-meta";
const OWNER = "x-tex-owner";

const pack = (value) => encodeURIComponent(JSON.stringify(value ?? null));
const unpack = (value) => {
  try {
    return value ? JSON.parse(decodeURIComponent(value)) : null;
  } catch {
    return null;
  }
};

/** The workspace object's reads: none of them changes anything (`workspaceStore/serve.js`). */
export const WS_READS = Object.freeze(
  new Set([
    "ws.read", "ws.visible", "ws.rows.digest", "ws.rows.lookup", "ws.rows.resolve", "ws.rows.names", "ws.facts", "ws.orient.survey",
    "ws.search", "ws.meaning.query", "ws.meaning.snippets", "ws.facts.rows", "ws.rows.manifest", "ws.rows.children", "ws.rows.get",
    "ws.rows.list", "ws.rules.get", "ws.state", "ws.open", "ws.access.check", "ws.access.state", "ws.access.render", "ws.members.list",
    "ws.members.get", "ws.members.digest", "ws.invites.list", "ws.invites.digest", "ws.invites.find", "ws.mail.since",
    "person.session", "person.state", "person.texting.get", "person.flags.get", "person.reach.list", "person.reach.digest",
    "person.shared.list", "person.shared.digest", "person.connections.list", "person.connections.digest", "token.get",
    "ws.machine.list", "ws.machine.get",
  ]),
);

/**
 * Reads that restamp row versions as they go (`ws.rows.files`, `ws.rows.listing`) or start a history (`ws.collab.read`
 * with `start`): answered "not served here", which every caller already reads as "ask the other way".
 */
const NOT_SERVED = Object.freeze(new Set(["ws.rows.files", "ws.rows.listing", "ws.search.build", "ws.meaning.build"]));

/** The Tex store's reads (`texStore/wire.js` `serveTexStore`). */
const KV_READS = Object.freeze(new Set(["head", "get"]));
const LEDGER_READS = Object.freeze(new Set(["ledger_read", "ledger_oldest", "ledger_chats"]));
const LEDGER_WRITES = Object.freeze(new Set(["ledger_append", "ledger_prepend"]));

/**
 * A turn's own run markers (`state/agent/running/<turn>`, `.../cancel/<turn>`): kept in the overlay like any key, so
 * the turn reads them back, but not listed as something the turn changed.
 */
const ownMarker = (key) => /^state\/agent\/(running|cancel)\//.test(String(key ?? ""));

/** What a change to a key is, for the Lab's list: Tex's routines and check-ins are reminders. */
function kindOfKey(key) {
  const text = String(key ?? "");
  if (/routines\/|heartbeat|checkin/i.test(text)) return "Reminder";
  return "Note";
}

/** What a refused `ws.*` op would have changed, for the Lab's list. */
function kindOfOp(op) {
  if (/^ws\.machine/.test(op)) return "Computer";
  if (/members|invites|access|rules|dropGrantee/.test(op)) return "Sharing";
  if (/^person\./.test(op)) return "Account";
  return "Note";
}

const refused = () => Response.json({ error: "refused", message: "A Lab test chat changes nothing outside itself." }, { status: 422 });
const okJson = (value = { ok: true }) => Response.json(value);
const randomEtag = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes) => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};
const unb64 = (text) => Uint8Array.from(atob(String(text ?? "")), (c) => c.charCodeAt(0));

/**
 * One real object's stub, as a test turn reaches it. `name` is the object's name, `gate` the test chat's
 * (`harness.js` `sandboxGate`): `kvGet/kvPut/kvList`, `ledger(obj, chat)` (the sandbox's ledger for the test chat, or
 * null), `record(write)`.
 */
export function sandboxedStub(stub, name, gate) {
  return {
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const call = unpack(request.headers.get(CALL));
      const op = typeof call?.op === "string" ? call.op : null;
      const owner = request.headers.get(OWNER);
      const obj = owner ? `${name}#${owner}` : name;
      if (op === null) {
        gate.record({ kind: "Other", summary: "an unnamed call to an object, refused" });
        return refused();
      }
      gate.saw?.(op);

      // The Tex store's notes: overlay first, then the real object.
      if (KV_READS.has(op)) {
        const kept = await gate.kvGet(obj, call.key);
        if (kept === null) return stub.fetch(request);
        if (kept.gone || kept.meta === null) return new Response(null, { headers: { [META]: pack(null) } });
        if (op === "head") return new Response(null, { headers: { [META]: pack(kept.meta) } });
        return new Response(unb64(kept.body ?? ""), { headers: { [META]: pack({ ...kept.meta, hasBody: true }) } });
      }
      if (op === "list") {
        const real = await (await stub.fetch(request)).json();
        const prefix = typeof call.options?.prefix === "string" ? call.options.prefix : "";
        const changed = await gate.kvList(obj, prefix);
        if (changed.length === 0) return okJson(real);
        const byKey = new Map((real.objects ?? []).map((entry) => [entry.key, entry]));
        for (const entry of changed) {
          if (entry.gone) byKey.delete(entry.key);
          else if (entry.meta) byKey.set(entry.key, entry.meta);
        }
        return okJson({ ...real, objects: [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) });
      }
      if (op === "put") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const meta = { key: call.key, size: bytes.byteLength, etag: randomEtag(), uploaded: Date.now(), ...(call.options?.httpMetadata ? { httpMetadata: call.options.httpMetadata } : {}), ...(call.options?.customMetadata ? { customMetadata: call.options.customMetadata } : {}) };
        await gate.kvPut(obj, call.key, { meta, body: b64(bytes) });
        if (!ownMarker(call.key)) gate.record({ kind: kindOfKey(call.key), summary: `saved ${String(call.key).slice(0, 120)}` });
        return new Response(null, { headers: { [META]: pack(meta) } });
      }
      if (op === "delete") {
        const keys = (Array.isArray(call.keys) ? call.keys : [call.keys]).filter((key) => typeof key === "string");
        for (const key of keys) await gate.kvPut(obj, key, { meta: null, gone: true });
        const listed = keys.filter((key) => !ownMarker(key));
        if (listed.length > 0) gate.record({ kind: kindOfKey(listed[0]), summary: `deleted ${listed.length === 1 ? listed[0].slice(0, 120) : `${listed.length} notes`}` });
        return okJson();
      }
      if (op === "page_list") return stub.fetch(request);
      if (op === "desk") {
        const real = await (await stub.fetch(request)).json();
        const ledger = gate.ledger(obj, DESK_LEDGER.chat);
        if (ledger === null) return okJson(real);
        return okJson({ ...real, ledger: await ledger.read(DESK_LEDGER.options) });
      }

      // The test chat's ledger is the sandbox's; any other chat's is read as it is and never written.
      if (LEDGER_READS.has(op) || LEDGER_WRITES.has(op)) {
        const ledger = gate.ledger(obj, call.chat);
        if (ledger !== null) {
          if (op === "ledger_read") return okJson(await ledger.read(call.options ?? {}));
          if (op === "ledger_oldest") return okJson({ oldest: await ledger.oldest() });
          if (op === "ledger_chats") return stub.fetch(request);
          const entries = await request.json().catch(() => []);
          if (op === "ledger_prepend") return okJson({ added: 0, kinds: [] });
          return okJson(await ledger.append(Array.isArray(entries) ? entries : []));
        }
        if (LEDGER_READS.has(op)) return stub.fetch(request);
        const entries = await request.json().catch(() => []);
        return okJson({ added: Array.isArray(entries) ? entries.length : 0, seq: 0, kinds: [] });
      }

      // Alarms never arm, locks are this turn's alone, the Tex page is never pushed.
      if (op === "schedule") {
        const alarm = await request.json().catch(() => null);
        const when = Number.isFinite(alarm?.at) ? new Date(alarm.at).toISOString().slice(0, 16).replace("T", " ") : "later";
        gate.record({ kind: "Reminder", summary: `an alarm set for ${when} UTC` });
        return okJson();
      }
      if (op === "cancel") {
        gate.record({ kind: "Reminder", summary: "an alarm cancelled" });
        return okJson();
      }
      if (op === "write_lock") return okJson({ ok: true });
      if (op === "write_unlock" || op === "page_poke") return okJson();
      if (op === "wipe") {
        gate.record({ kind: "Note", summary: "Tex's notes wiped" });
        return okJson();
      }

      // The workspace object's rows and everything else it keeps. Its kept storage binding is left out of `ws.open`, so
      // the store asks the control plane, whose answer the gate hands back with its keys blanked (`policy.js`).
      if (op === "ws.open") {
        const real = await (await stub.fetch(request)).json();
        return okJson(real && typeof real === "object" ? { ...real, binding: null } : real);
      }
      if (WS_READS.has(op)) return stub.fetch(request);
      if (op === "ws.collab.read") {
        const fields = await request.clone().json().catch(() => ({}));
        if (fields?.start === true) return okJson({ served: false });
        return stub.fetch(request);
      }
      if (NOT_SERVED.has(op)) return okJson({ served: false });
      // The store caching the storage binding it was handed (blanked, `policy.js`): never kept, and not the turn's doing.
      if (op === "ws.binding.put") return okJson({ ok: true });
      if (op === "ws.write.wrote") {
        gate.record({ kind: "Note", summary: "a note's save recorded" });
        return okJson({ ok: true, at: Date.now() });
      }
      if (op === "ws.mark.open" || op === "ws.mark.close") return okJson(op === "ws.mark.open" ? { open: true, until: Date.now() + 60_000 } : { closed: true });
      gate.record({ kind: kindOfOp(op), summary: `${op.slice(0, 60)} (refused in the test chat)` });
      return refused();
    },
  };
}

/**
 * A Durable Object namespace whose every stub is `sandboxedStub`. Only names reach it: an id from a string is refused.
 * Its stubs are made through the gateway's place helper (`objectPlace.js`), as every stub here is.
 */
export function sandboxNamespace(real, gate) {
  if (!real || typeof real.idFromName !== "function") return undefined;
  const names = new WeakMap();
  return {
    idFromName: (name) => {
      const handle = { toString: () => objectIdOf(real, name), equals: (other) => String(other) === objectIdOf(real, name) };
      names.set(handle, name);
      return handle;
    },
    idFromString: () => {
      throw new Error("a Lab test chat reaches objects by name only");
    },
    newUniqueId: () => {
      throw new Error("a Lab test chat makes no objects");
    },
    get: (handle) => {
      const name = names.get(handle);
      if (name === undefined) throw new Error("a Lab test chat reaches objects by name only");
      return sandboxedStub(objectByName(real, name), name, gate);
    },
  };
}

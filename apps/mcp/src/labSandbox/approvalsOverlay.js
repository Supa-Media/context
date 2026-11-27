/**
 * A Lab test chat's held asks, kept in the test chat (2026-11-27, `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * Since `REAL_GATE` a test turn's email runs the real email gate, which keeps the held copy as an approval record
 * under `.context/approvals/` (`tools/approvals.js`) and reads it back on the person's yes. Those keys live in the
 * workspace's bucket, which a test turn cannot reach: its binding comes back keyless (`policy.js` `withoutKeys`), so
 * the first read threw and the call failed (Lab test chat, 2026-11-27: "That call failed", 32 ms). Here every read
 * and write under that prefix is the test chat's own overlay (`harness.js` `kvGet`/`kvPut`/`kvList`), the same one a
 * Tex store key changed in a test turn lands in: a test chat starts with no held asks, keeps the ones its turns
 * raise, and never reads or writes the real ones.
 */

import { APPROVALS_PREFIX } from "../tools/approvalKeys.js";

const isApproval = (key) => typeof key === "string" && key.startsWith(APPROVALS_PREFIX);
const randomEtag = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes) => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};
const unb64 = (text) => Uint8Array.from(atob(String(text ?? "")), (c) => c.charCodeAt(0));

async function bytesOf(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
  return new TextEncoder().encode(String(value ?? ""));
}

/** One kept record as the store hands an object back: its key, etag, size, and its body to read. */
function objectOf(key, kept) {
  const bytes = unb64(kept.body ?? "");
  const meta = kept.meta ?? {};
  return {
    key,
    etag: meta.etag,
    httpEtag: `"${meta.etag}"`,
    size: bytes.byteLength,
    uploaded: new Date(meta.uploaded ?? Date.now()),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

/**
 * `store` with its approval keys answered from the test chat `gate` (`harness.js` `sandboxGate`), as the
 * workspace's: changed in place, so every property the store carries stays as it is. A store with no gate, or a
 * gate with no overlay (a unit test's), is handed back unchanged.
 */
export function withTestChatApprovals(store, gate, workspaceId) {
  if (!store || !gate || typeof gate.kvGet !== "function" || typeof gate.kvPut !== "function" || typeof gate.kvList !== "function") return store;
  const obj = `approvals#workspace:${String(workspaceId ?? "")}`;
  const real = { get: store.get?.bind(store), head: store.head?.bind(store), put: store.put?.bind(store), delete: store.delete?.bind(store), list: store.list?.bind(store) };
  const live = async (key) => {
    const kept = await gate.kvGet(obj, key);
    return kept === null || kept.gone || kept.meta === null ? null : kept;
  };
  store.get = async (key, ...rest) => {
    if (!isApproval(key)) return real.get(key, ...rest);
    const kept = await live(key);
    return kept === null ? null : objectOf(key, kept);
  };
  store.head = async (key, ...rest) => {
    if (!isApproval(key)) return real.head?.(key, ...rest);
    const kept = await live(key);
    return kept === null ? null : { etag: kept.meta.etag, size: unb64(kept.body ?? "").byteLength };
  };
  store.put = async (key, value, options, ...rest) => {
    if (!isApproval(key)) return real.put(key, value, options, ...rest);
    const kept = await live(key);
    const expected = options?.onlyIf?.etagMatches;
    if (typeof expected === "string" && kept?.meta?.etag !== expected.replace(/"/g, "")) return null;
    if (options?.onlyIf?.absent === true && kept !== null) return null;
    const bytes = await bytesOf(value);
    const meta = { key, size: bytes.byteLength, etag: randomEtag(), uploaded: Date.now() };
    await gate.kvPut(obj, key, { meta, body: b64(bytes) });
    return { key, etag: meta.etag, size: meta.size };
  };
  store.delete = async (key, options, ...rest) => {
    const keys = Array.isArray(key) ? key : [key];
    if (!keys.some(isApproval)) return real.delete(key, options, ...rest);
    for (const one of keys) {
      if (!isApproval(one)) continue;
      const expected = options?.onlyIf?.etagMatches;
      if (typeof expected === "string") {
        const kept = await live(one);
        if (kept === null || kept.meta.etag !== expected.replace(/"/g, "")) return null;
      }
      await gate.kvPut(obj, one, { meta: null, gone: true });
    }
    const others = keys.filter((one) => !isApproval(one));
    if (others.length > 0) await real.delete(Array.isArray(key) ? others : others[0], options, ...rest);
    return undefined;
  };
  store.list = async (options = {}, ...rest) => {
    const prefix = typeof options?.prefix === "string" ? options.prefix : "";
    if (!isApproval(prefix)) return real.list(options, ...rest);
    const kept = (await gate.kvList(obj, prefix)).filter((entry) => !entry.gone && entry.meta).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const objects = kept.map((entry) => ({ key: entry.key, etag: entry.meta.etag, size: entry.meta.size, uploaded: new Date(entry.meta.uploaded ?? Date.now()) }));
    return { objects, truncated: false, delimitedPrefixes: [] };
  };
  return store;
}

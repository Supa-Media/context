import assert from "node:assert/strict";
import { test } from "node:test";
import { newEntryId, writeEntry } from "../src/vault/entries.js";
import { HIDDEN, echoForms, isSharedHost, proxyFetch, proxyPin, savedPin } from "../src/vault/proxy.js";
import { toolVaultFetch, toolVaultList } from "../src/tools/vault.js";
import { mightWiden, wideningOf } from "../src/privacy/egress.js";
import { AUDIT_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";

const KEY = "fake-vault-value-not-a-real-key-0042";
const material = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const KEYS = { current: "k1", keys: { k1: material } };

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

/** A recording fetch that answers what `reply` builds from the request it was given. */
function fakeFetch(reply = () => new Response("{}", { headers: { "content-type": "application/json" } })) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return reply(url, init);
  };
  return { calls, impl };
}

async function proxyVault({ proxy = { host: "api.stripe.com", style: "bearer", ask: false }, people = ["user_a"], userId = "user_a", value = KEY } = {}) {
  const store = memoryStore();
  const id = newEntryId();
  await writeEntry(store, KEYS, "ws_1", {
    id,
    meta: {
      type: "secret",
      name: "Stripe",
      sites: [],
      people,
      fields: [{ name: "STRIPE_SECRET_KEY", perEnv: true, set: ["prod"] }],
      ...(proxy ? { proxy } : {}),
      createdBy: "user_a",
      createdAt: 1,
      updatedAt: 1,
    },
    secret: { fields: [{ name: "STRIPE_SECRET_KEY", perEnv: true, values: { prod: value } }] },
  });
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  store.actor = { workspaceId: "ws_1", userId, clientId: "client_x", workspaceKind: "shared" };
  return { store, id };
}

function withProxy(store, fetchImpl) {
  Object.defineProperty(store, "vaultProxy", { value: { fetch: fetchImpl }, enumerable: false, configurable: true });
  return store;
}

const ask = (id, url, extra = {}) => ({ entry: id, field: "STRIPE_SECRET_KEY", env: "prod", url, ...extra });

function auditEntries(store) {
  return [...store.objects.entries()].filter(([key]) => key.startsWith(AUDIT_PREFIX)).map(([, value]) => JSON.parse(value));
}

test("the key goes only to the pinned host: another host, a host beneath it or one that merely starts with it gets nothing", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch();
  withProxy(store, net.impl);
  for (const url of [
    "https://webhook.site/abc",
    "https://evil.api.stripe.com/v1/customers",
    "https://api.stripe.com.evil.io/v1/customers",
    "https://stripe.com/v1/customers",
  ]) {
    const result = await toolVaultFetch(store, ask(id, url));
    assert.equal(result.isError, true, url);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  }
  assert.equal(net.calls.length, 0, "nothing was sent anywhere");
  const refused = auditEntries(store).filter((entry) => entry.action === "vault_proxy_refused");
  assert.equal(refused.length, 4);
  assert.ok(refused.every((entry) => entry.details.reason === "wrong_site"));
});

test("http, a port or a username in the address is refused before anything is sent", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch();
  withProxy(store, net.impl);
  for (const url of ["http://api.stripe.com/v1/customers", "https://api.stripe.com:8443/v1", "https://me:pw@api.stripe.com/v1"]) {
    const result = await toolVaultFetch(store, ask(id, url));
    assert.equal(result.isError, true, url);
  }
  assert.equal(net.calls.length, 0);
});

test("the key is added as the site wants it and redirects are never followed", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch();
  withProxy(store, net.impl);
  const result = await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/customers?limit=3", { headers: [{ name: "Authorization", value: "Bearer guess" }, { name: "Cookie", value: "a=b" }] }));
  assert.equal(result.isError, undefined);
  assert.equal(net.calls.length, 1);
  const { url, init } = net.calls[0];
  assert.equal(url, "https://api.stripe.com/v1/customers?limit=3");
  assert.equal(init.headers.get("authorization"), `Bearer ${KEY}`, "the AI's own Authorization is replaced");
  assert.equal(init.headers.get("cookie"), null);
  assert.equal(init.redirect, "manual");
});

test("a named header and a query parameter carry the key where the entry says", async () => {
  const header = await proxyVault({ proxy: { host: "api.example.com", style: "header", name: "X-Api-Key", ask: false } });
  const net = fakeFetch();
  withProxy(header.store, net.impl);
  await toolVaultFetch(header.store, ask(header.id, "https://api.example.com/v2/things"));
  assert.equal(net.calls[0].init.headers.get("x-api-key"), KEY);
  assert.equal(net.calls[0].init.headers.get("authorization"), null);

  const query = await proxyVault({ proxy: { host: "api.example.com", style: "query", name: "api_key", ask: false } });
  const echo = fakeFetch((url) => new Response(null, { status: 302, headers: { location: url } }));
  withProxy(query.store, echo.impl);
  const result = await toolVaultFetch(query.store, ask(query.id, "https://api.example.com/v2/things?q=1"));
  assert.equal(new URL(echo.calls[0].url).searchParams.get("api_key"), KEY);
  const text = JSON.stringify(result);
  assert.equal(text.includes(KEY), false, "the redirect's address carried the key back and it was hidden");
  assert.ok(text.includes(HIDDEN));
});

test("an answer that repeats the key, in any encoding, reaches the model with it hidden", async () => {
  const { store, id } = await proxyVault();
  const basic = Buffer.from(`user:${KEY}`).toString("base64");
  const urlSafe = Buffer.from(`ab${KEY}`).toString("base64url");
  const body = JSON.stringify({
    raw: KEY,
    encoded: encodeURIComponent(KEY),
    hex: Buffer.from(KEY).toString("hex"),
    basic,
    urlSafe,
  });
  const net = fakeFetch(() => new Response(body, { headers: { "content-type": "application/json", "x-request-id": `req ${KEY}` } }));
  withProxy(store, net.impl);
  const result = await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/echo"));
  const text = JSON.stringify(result);
  for (const form of [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString("hex")]) {
    assert.equal(text.includes(form), false, form);
  }
  // The base64 forms differ only at their edges, so none of the key's own run survives.
  assert.equal(text.includes(basic), false);
  assert.equal(text.includes(urlSafe), false);
  assert.ok(text.includes("the answer held the key"));
});

test("every encoded form is found at each alignment", () => {
  const forms = echoForms(KEY);
  for (const lead of ["", "a", "ab", "abc"]) {
    const encoded = Buffer.from(`${lead}${KEY}`).toString("base64");
    assert.ok(forms.some((form) => encoded.includes(form)), `lead ${JSON.stringify(lead)}`);
  }
});

test("an answer that is not text is never returned, only its size", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch(() => new Response(new Uint8Array([1, 2, 3, ...Buffer.from(KEY)]), { headers: { "content-type": "application/octet-stream" } }));
  withProxy(store, net.impl);
  const result = await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/file"));
  const text = JSON.stringify(result);
  assert.equal(text.includes(KEY), false);
  assert.ok(text.includes("bytes, not shown"));
});

test("an answer declared too large is not read", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch(() => new Response(KEY, { headers: { "content-type": "text/plain", "content-length": "9000000" } }));
  withProxy(store, net.impl);
  const text = JSON.stringify(await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/big")));
  assert.equal(text.includes(KEY), false);
  assert.match(text, /too large/);
});

test("an entry not given to this person, or saved without a pin, sends nothing", async () => {
  const stranger = await proxyVault({ userId: "user_b" });
  const net = fakeFetch();
  withProxy(stranger.store, net.impl);
  assert.equal((await toolVaultFetch(stranger.store, ask(stranger.id, "https://api.stripe.com/v1"))).isError, true);

  const unpinned = await proxyVault({ proxy: null });
  withProxy(unpinned.store, net.impl);
  assert.equal((await toolVaultFetch(unpinned.store, ask(unpinned.id, "https://api.stripe.com/v1"))).isError, true);
  assert.equal(net.calls.length, 0);
});

test("a pin to a host anyone can publish under never works", async () => {
  for (const host of ["myapp.workers.dev", "webhook.site", "someone.github.io", "x.ngrok-free.app"]) {
    assert.equal(isSharedHost(host), true, host);
    assert.equal(proxyPin({ proxy: { host, style: "bearer" } }), null, host);
  }
  assert.equal(isSharedHost("api.stripe.com"), false);
  const { store, id } = await proxyVault({ proxy: { host: "hooks.workers.dev", style: "bearer", ask: false } });
  const net = fakeFetch();
  withProxy(store, net.impl);
  assert.equal((await toolVaultFetch(store, ask(id, "https://hooks.workers.dev/x"))).isError, true);
  assert.equal(net.calls.length, 0);
});

test("a key that asks first is not sent until the person says yes (vaultAsks.test.mjs has the rest)", async () => {
  const { store, id } = await proxyVault({ proxy: { host: "api.stripe.com", style: "bearer" } });
  const net = fakeFetch();
  withProxy(store, net.impl);
  const result = await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/customers"));
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Waiting for the person/);
  assert.equal(net.calls.length, 0);
});

test("the decision on each use is the caller's: a refusal from it sends nothing", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch();
  let asked = null;
  await assert.rejects(
    proxyFetch(store, ask(id, "https://api.stripe.com/v1/customers"), {
      allowed: (question) => {
        asked = question;
        return { allowed: false, code: "said_no", message: "no" };
      },
      fetchImpl: net.impl,
    }),
    (error) => error.code === "said_no",
  );
  assert.equal(asked.pin.host, "api.stripe.com");
  assert.equal(net.calls.length, 0);
});

test("a value too short to hide is never sent", async () => {
  const { store, id } = await proxyVault({ value: "abc123" });
  const net = fakeFetch();
  withProxy(store, net.impl);
  assert.equal((await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1"))).isError, true);
  assert.equal(net.calls.length, 0);
});

test("with the deployment switch off, fetch is refused and nothing is sent", async () => {
  const { store, id } = await proxyVault();
  const result = await toolVaultList(store, { fetch: ask(id, "https://api.stripe.com/v1") });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /not switched on/);
});

test("the audit entry names the address but never the query, a header value, the body or the key", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch(() => new Response(`{"echo":"${KEY}"}`, { headers: { "content-type": "application/json" } }));
  withProxy(store, net.impl);
  await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/customers?email=private%40example.test", { method: "POST", body: "secret-body-text", headers: [{ name: "X-Note", value: "private-header" }] }));
  const [entry] = auditEntries(store).filter((row) => row.action === "vault_proxied");
  assert.ok(entry);
  assert.equal(entry.details.host, "api.stripe.com");
  assert.equal(entry.details.path, "/v1/customers");
  assert.equal(entry.details.status, 200);
  assert.equal(entry.details.hidden, true);
  const raw = JSON.stringify(entry);
  for (const leaked of [KEY, "private%40example.test", "private@example.test", "secret-body-text", "private-header"]) {
    assert.equal(raw.includes(leaked), false, leaked);
  }
});

test("vault_list says which entries can be used through fetch, and where", async () => {
  const { store } = await proxyVault();
  const text = JSON.stringify(await toolVaultList(store, {}));
  assert.match(text, /usable through fetch on api\.stripe\.com/);
  assert.equal(text.includes(KEY), false);
});

test("a request through Context counts as sending outside the workspace for the approval gate", async () => {
  const args = { fetch: { entry: "v0", field: "K", url: "https://api.stripe.com/v1" } };
  assert.equal(mightWiden("vault_list", args), true);
  assert.equal(mightWiden("vault_list", {}), false);
  const widening = await wideningOf("vault_list", args, { privacy: async () => ({ rules: [], overrides: {} }) });
  assert.equal(widening.audience, "outside");
  assert.match(widening.summary, /api\.stripe\.com/);
  assert.equal(await wideningOf("vault_list", {}, { privacy: async () => ({ rules: [], overrides: {} }) }), null);
});

test("the save page's pin is checked by the rules every use checks", () => {
  assert.deepEqual(savedPin({ host: "https://API.Stripe.com/v1", style: "bearer", name: "ignored", ask: true }), {
    pin: { host: "api.stripe.com", style: "bearer", ask: true },
  });
  assert.deepEqual(savedPin({ host: "api.anthropic.com", style: "header", name: " x-api-key ", ask: false }), {
    pin: { host: "api.anthropic.com", style: "header", name: "x-api-key", ask: false },
  });
  assert.equal(savedPin({ host: "api.example.com", style: "query", name: "api_key" }).pin.ask, true, "the ask is on unless turned off");
  for (const host of ["my-thing.workers.dev", "webhook.site", "x.ngrok-free.app"]) {
    assert.match(savedPin({ host, style: "bearer" }).problem, /Anyone can put a page/, host);
  }
  assert.match(savedPin({ host: "localhost", style: "bearer" }).problem, /Enter the website/);
  assert.match(savedPin({ host: "api.example.com:8443", style: "bearer" }).problem, /Enter the website/);
  assert.match(savedPin({ host: "api.example.com", style: "cookie" }).problem, /Choose how/);
  assert.match(savedPin({ host: "api.example.com", style: "header", name: "bad header" }).problem, /Name the header/);
  assert.match(savedPin({ host: "api.example.com", style: "query", name: "" }).problem, /Name the address part/);
  assert.match(savedPin(null).problem, /Say which website/);
  // What it stores is exactly what a use reads back.
  const { pin } = savedPin({ host: "api.example.com", style: "header", name: "x-api-key", ask: false });
  assert.deepEqual(proxyPin({ proxy: pin }), { host: "api.example.com", style: "header", name: "x-api-key" });
});

test("a non-text answer cannot hand the key back in its content type", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch(
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": `application/octet-stream; boundary=${KEY}` },
      }),
  );
  withProxy(store, net.impl);
  const result = await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/files/f_1"));
  assert.notEqual(result.isError, true);
  const text = JSON.stringify(result);
  assert.equal(text.includes(KEY), false, "the content type echoed the key back to the model");
  assert.ok(text.includes(HIDDEN));
});

test("the AI cannot ask the site for an answer Context would not be able to read", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch();
  withProxy(store, net.impl);
  await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/customers", { headers: [{ name: "accept-encoding", value: "gzip" }] }));
  const sent = [...net.calls[0].init.headers.keys()];
  assert.equal(sent.includes("accept-encoding"), false, "the AI chose the answer's encoding");
});

test("an answer Context cannot read is not passed through unread", async () => {
  const { store, id } = await proxyVault();
  const net = fakeFetch(
    () =>
      new Response("the site's own words, never decoded", {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      }),
  );
  withProxy(store, net.impl);
  const result = await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/customers"));
  const text = JSON.stringify(result);
  assert.equal(text.includes("the site's own words"), false, "a body Context could not read reached the model anyway");
  assert.match(text, /could not read/);
});

test("an answer that declares no length is still not read past the cap", async () => {
  const chunk = new Uint8Array(1_000_000);
  const net = fakeFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 6; i += 1) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const { store, id } = await proxyVault();
  withProxy(store, net.impl);
  const result = await toolVaultFetch(store, ask(id, "https://api.stripe.com/v1/big"));
  assert.match(JSON.stringify(result), /too large to read through Context/);
});

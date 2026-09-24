/**
 * The control-plane transport: the one `fetch` call every method in this
 * folder is built on, plus the shared error type and constants.
 *
 * The full contract (what each route means, and why the two-proof model in
 * `getStorageBinding` etc. is non-negotiable) is documented at the top of
 * `../controlPlane.js`, which this folder implements.
 */

/** How long a control-plane call may take before the gateway gives up. */
export const CONTROL_PLANE_TIMEOUT_MS = 8_000;

/**
 * Cap on a control-plane response body.
 *
 * Small on purpose: every documented payload is a few hundred bytes, and the
 * gateway has no reason to buffer more from anything, including a service it
 * trusts. A trusted service having a bad day is still a way to exhaust a
 * Worker.
 */
export const CONTROL_PLANE_RESPONSE_BYTE_CAP = 256_000;

/**
 * A control-plane call did not produce a usable answer.
 *
 * Carries a short reason for the gateway's own structured logs and nothing
 * else. It never carries the response body, the gateway secret, a token hash,
 * a workspace id, or a storage credential — an error string is the easiest
 * place in a system for a secret to escape, and this is the type that would
 * carry it.
 */
export class ControlPlaneError extends Error {
  /**
   * `status` is the control plane's HTTP status when there was one, and `null`
   * for a transport failure. Carried as a field rather than left to be parsed
   * back out of `reason`, because a caller that needs to tell one status from
   * another would otherwise match on a message — and a message is the thing
   * most likely to be reworded by somebody who does not know it is load
   * bearing.
   */
  constructor(reason, status = null) {
    super(`control plane unavailable: ${reason}`);
    this.name = "ControlPlaneError";
    this.reason = reason;
    this.status = status;
  }
}

/** SHA-256 of a string, lowercase hex — the only form a token reaches Convex in. */
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Loopback hosts, in the spellings `URL` produces.
 *
 * Lives here rather than in `oauth.js` because that module already imports from
 * this one; the reverse would be a cycle. Shared so "http is only ever
 * acceptable to this machine" is stated once instead of drifting between the
 * redirect-URI rules, the consent-URL check, and the control-plane URL check.
 */
export function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

function requireConfig(env) {
  const base = typeof env?.CONTROL_PLANE_URL === "string" ? env.CONTROL_PLANE_URL.trim() : "";
  const secret = typeof env?.GATEWAY_SECRET === "string" ? env.GATEWAY_SECRET : "";
  if (!base || !secret) {
    // Deliberately vague and deliberately fatal. A gateway with no control
    // plane has no tenants; it must refuse every request rather than degrade
    // into some other access path.
    throw new ControlPlaneError("not configured");
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new ControlPlaneError("not configured");
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    // Every response on this channel can carry a decrypted storage secret, so
    // it must be encrypted in transit. The exception is loopback, for a control
    // plane running on the same machine during development — it cannot leave
    // the host. This used to exempt the literal hostname `control-plane.test`
    // instead, which put a cleartext carve-out for one specific name into a
    // production code path that no deployment could turn off; the test double
    // is https and never needed it.
    throw new ControlPlaneError("not configured");
  }
  return { base: base.replace(/\/+$/, ""), secret };
}

/**
 * The `post`/`required` pair every method group in this folder is built on.
 *
 * Constructed per request, mirroring `createControlPlane` itself: it holds
 * the gateway secret in memory for the life of one call and nothing else —
 * no connection pool, no memo, no module-level state that a reused isolate
 * could carry into the next tenant's request.
 */
export function createTransport(env, fetchImpl) {
  async function post(path, body) {
    const { base, secret } = requireConfig(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROL_PLANE_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          // The secret appears here and nowhere else in the process.
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // "manual", not "error". workerd does not implement `redirect: "error"`
        // — fetch rejects with a TypeError before the request is made, and the
        // catch below flattens that to "request failed", so every control-plane
        // call fails identically and invisibly. This is the same defect that
        // stopped the email worker dead; see infra/email-worker/src/controlPlane.ts.
        //
        // "manual" keeps the intent: a redirect is surfaced as a response rather
        // than followed, and the status check below refuses anything that is not
        // a 200 — so no credential is replayed to a Location we did not choose.
        redirect: "manual",
      });
    } catch {
      // The caught error may quote the request — headers included. It is
      // dropped on the floor rather than wrapped.
      throw new ControlPlaneError("request failed");
    } finally {
      clearTimeout(timer);
    }

    if (!response || response.status !== 200) {
      // Status only. A control-plane error body is not something this worker
      // relays: it is written for operators, and the caller is an AI client on
      // the internet.
      throw new ControlPlaneError(
        `status ${response?.status ?? "none"}`,
        response?.status ?? null
      );
    }
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > CONTROL_PLANE_RESPONSE_BYTE_CAP) {
      throw new ControlPlaneError("response too large");
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw new ControlPlaneError("response unreadable");
    }
    if (text.length > CONTROL_PLANE_RESPONSE_BYTE_CAP) {
      throw new ControlPlaneError("response too large");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ControlPlaneError("response not json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ControlPlaneError("response not an object");
    }
    return parsed;
  }

  /**
   * Read one documented key out of a response, insisting the key was actually
   * present.
   *
   * The difference between `null` and `undefined` is load-bearing here. An
   * explicit `null` is the contract's "nothing matched" and is a clean refusal.
   * A *missing* key is a control plane that answered something other than what
   * this file documents — a version skew, a proxy, a wrong URL — and must not
   * be read as "nothing matched", because the same laxness would read a
   * `{"binding": undefined}` as "no binding" when the real answer might have
   * been a binding for the wrong tenant.
   */
  function required(parsed, key) {
    if (!(key in parsed)) throw new ControlPlaneError(`response missing ${key}`);
    return parsed[key];
  }

  return { post, required };
}

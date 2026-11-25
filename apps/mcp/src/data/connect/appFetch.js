/**
 * One call to a connected app's own API, from the sync object: a fixed https host, no redirects, a timeout and a
 * byte cap. The answer is JSON or a refusal sentence; the key never appears in either, nor in a log.
 */

export const APP_TIMEOUT_MS = 20_000;
export const APP_MAX_BYTES = 4 * 1024 * 1024;

/** `{ok: true, status, body}` or `{ok: false, status, said}`. `said` is a plain sentence naming the app. */
export async function appJson(fetcher, url, init, appName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_TIMEOUT_MS);
  let response;
  try {
    response = await fetcher(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch {
    clearTimeout(timer);
    return { ok: false, status: 0, said: `${appName} didn't answer` };
  }
  try {
    if (response.status >= 300 && response.status < 400) return { ok: false, status: response.status, said: `${appName} answered with a redirect` };
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > APP_MAX_BYTES) return { ok: false, status: response.status, said: `${appName}'s answer was too large` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > APP_MAX_BYTES) return { ok: false, status: response.status, said: `${appName}'s answer was too large` };
    let body = null;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = null;
    }
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, said: `${appName} refused the key` };
    if (response.status === 429) return { ok: false, status: 429, said: `${appName} asked Context to slow down` };
    if (response.status < 200 || response.status >= 300 || body === null) return { ok: false, status: response.status, said: `${appName} answered ${response.status}` };
    return { ok: true, status: response.status, body };
  } catch {
    return { ok: false, status: 0, said: `${appName}'s answer couldn't be read` };
  } finally {
    clearTimeout(timer);
  }
}

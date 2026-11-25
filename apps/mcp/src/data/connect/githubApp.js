/**
 * GitHub, connected as a read-only GitHub App the owner installs (`docs/decisions/data-and-metrics.md`, "GitHub").
 *
 * The App is the deployment's own (`GH_DATA_APP_ID`, `GH_DATA_PRIVATE_KEY`, `GH_DATA_APP_SLUG`, `GH_DATA_CLIENT_ID`,
 * `GH_DATA_CLIENT_SECRET`, Worker secrets set from GitHub on deploy). What a workspace keeps, sealed in its sync
 * object, is only which installation it reads and which of that installation's repositories: never a token.
 *
 * - **Install, bound to the owner who asked.** The owner's Connect asks the gateway for an install address whose
 *   `state` is signed for this workspace, this person and this source, for 30 minutes (`installState`). GitHub
 *   sends the owner back with that state, a one-time code and the installation's id. The gateway checks the state
 *   against the owner's own session, trades the code for the owner's GitHub token, and keeps the installation only
 *   if GitHub lists it among the installations that person can reach. That token is then revoked; it is never kept.
 *   An installation id alone, or one from somebody else's link, binds nothing.
 * - **Every run mints its own token**, an hour long, from the App's key, narrowed to read-only Metadata, Pull
 *   requests, Deployments and Actions whatever the App itself is later given. An uninstalled App, or one whose
 *   access was cut, refuses the mint and the source stops.
 */

import { appJson } from "./appFetch.js";

export const GITHUB_API = "https://api.github.com";
const LOGIN = "https://github.com/login/oauth/access_token";
const NAME = "GitHub";
const INSTALLATION = /^[0-9]{1,15}$/;
const CODE = /^[A-Za-z0-9_-]{8,80}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATE_MS = 30 * 60_000;
const STATE_INFO = new TextEncoder().encode("context github install state v1");
/** What a run's token may do, whatever the App is given later. */
export const READ_ONLY = Object.freeze({ metadata: "read", pull_requests: "read", deployments: "read", actions: "read" });
const MAX_INSTALLATION_PAGES = 5;
const MAX_REPO_PAGES = 10;

export const githubHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "context-data-sync",
});

/** The deployment's App, or null when it has none (a self-hosted install without one). */
export function githubAppOf(env) {
  const id = String(env?.GH_DATA_APP_ID ?? "").trim();
  // A key pasted with its line breaks written out as \n reads the same.
  const key = String(env?.GH_DATA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const slug = String(env?.GH_DATA_APP_SLUG ?? "").trim();
  const clientId = String(env?.GH_DATA_CLIENT_ID ?? "").trim();
  const clientSecret = String(env?.GH_DATA_CLIENT_SECRET ?? "").trim();
  if (!/^[0-9]{1,15}$/.test(id) || !key.includes("PRIVATE KEY") || !SLUG.test(slug) || clientId === "" || clientSecret === "") return null;
  return { id, key, slug, clientId, clientSecret };
}

function b64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const text64 = (value) => b64url(new TextEncoder().encode(value));

function fromB64(text) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)), (char) => char.charCodeAt(0));
}

/** A DER length. */
function derLength(length) {
  if (length < 0x80) return [length];
  const bytes = [];
  for (let left = length; left > 0; left >>= 8) bytes.unshift(left & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag, body) => Uint8Array.from([tag, ...derLength(body.length), ...body]);

/**
 * The App's private key as PKCS#8 DER, which Web Crypto imports. GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`);
 * that is wrapped in PKCS#8's envelope (version 0, rsaEncryption, the key as an octet string).
 */
export function pkcs8Of(pem) {
  const rsa = /-----BEGIN RSA PRIVATE KEY-----/.test(pem);
  const body = fromB64(pem.replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, "").replace(/\s+/g, ""));
  if (!rsa) return body;
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return der(0x30, [...version, ...algorithm, ...der(0x04, [...body])]);
}

/** A JWT the App signs for itself (RS256), good for nine minutes, back-dated one for clock skew. */
export async function appJwt(app, nowMs) {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8Of(app.key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const at = Math.floor(nowMs / 1000);
  const signing = `${text64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${text64(JSON.stringify({ iat: at - 60, exp: at + 540, iss: app.id }))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signing)));
  return `${signing}.${b64url(signature)}`;
}

/**
 * An installation token, read-only and narrowed to `READ_ONLY`: `{ok: true, token}` or `{ok: false, said, refused}`.
 * `refused` means the installation is gone or no longer grants what the source reads.
 */
export async function installationToken({ app, installation, fetcher, nowMs }) {
  if (!INSTALLATION.test(String(installation))) return { ok: false, refused: true, said: "GitHub's installation isn't one Context knows" };
  let jwt;
  try {
    jwt = await appJwt(app, nowMs);
  } catch {
    return { ok: false, refused: false, said: "This deployment's GitHub App key can't sign" };
  }
  const minted = await appJson(
    fetcher,
    `${GITHUB_API}/app/installations/${installation}/access_tokens`,
    { method: "POST", headers: { ...githubHeaders(jwt), "content-type": "application/json" }, body: JSON.stringify({ permissions: READ_ONLY }) },
    NAME,
  );
  if (!minted.ok) {
    const refused = minted.status === 401 || minted.status === 403 || minted.status === 404 || minted.status === 422;
    return { ok: false, refused, said: refused ? "GitHub no longer lets Context read this installation; it was uninstalled or its access changed" : minted.said };
  }
  const token = typeof minted.body?.token === "string" ? minted.body.token : "";
  return token === "" ? { ok: false, refused: false, said: "GitHub didn't hand over a token" } : { ok: true, token };
}

async function stateKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("no gateway secret");
  // One HMAC step over the label, its own key apart from every other use of the gateway secret.
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", base, STATE_INFO);
  return await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The signed install state: this workspace, this person, this source's about.md note, for 30 minutes. */
export async function installState({ secret, workspaceId, userId, noteId, nowMs }) {
  const body = text64(JSON.stringify({ w: workspaceId, u: userId, n: noteId, e: nowMs + STATE_MS }));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await stateKey(secret), new TextEncoder().encode(body)));
  return `${body}.${b64url(mac)}`;
}

/** The state's fields when its signature holds and it is still fresh, or null. */
export async function readInstallState({ secret, state, nowMs }) {
  if (typeof state !== "string" || state.length > 600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state)) return null;
  const [body, mac] = state.split(".");
  let fields;
  try {
    if (!(await crypto.subtle.verify("HMAC", await stateKey(secret), fromB64(mac), new TextEncoder().encode(body)))) return null;
    fields = JSON.parse(new TextDecoder().decode(fromB64(body)));
  } catch {
    return null;
  }
  if (typeof fields?.w !== "string" || typeof fields.u !== "string" || typeof fields.n !== "string" || !(fields.e > nowMs)) return null;
  return { workspaceId: fields.w, userId: fields.u, noteId: fields.n };
}

/** Where the owner installs the App: GitHub's own page, carrying the signed state back. */
export const installUrl = (app, state) => `https://github.com/apps/${app.slug}/installations/new?state=${encodeURIComponent(state)}`;

/**
 * The owner's return from GitHub, checked: the code traded for the owner's GitHub token, the installation found
 * among the ones that person can reach, the token revoked, and a read-only token minted to prove the App can read.
 * `{ok: true, kept: {installation, repos: null}}` or `{ok: false, said}`. `repos: null` reads every repository the
 * installation was given, until the owner picks.
 */
export async function checkGithubInstall(input, fetcher, env, nowMs = Date.now()) {
  const app = githubAppOf(env);
  if (app === null) return { ok: false, said: "This deployment has no GitHub App set up" };
  const code = typeof input?.code === "string" ? input.code : "";
  const installation = typeof input?.installation === "string" ? input.installation : "";
  if (!CODE.test(code) || !INSTALLATION.test(installation)) return { ok: false, said: "GitHub's answer was incomplete; connect it again" };
  const traded = await appJson(
    fetcher,
    LOGIN,
    { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "context-data-sync" }, body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }) },
    NAME,
  );
  const userToken = traded.ok && typeof traded.body?.access_token === "string" ? traded.body.access_token : "";
  if (userToken === "") return { ok: false, said: "GitHub didn't confirm who approved it; connect it again" };
  let reachable = false;
  try {
    for (let page = 1; page <= MAX_INSTALLATION_PAGES && !reachable; page += 1) {
      const listed = await appJson(fetcher, `${GITHUB_API}/user/installations?per_page=100&page=${page}`, { headers: githubHeaders(userToken) }, NAME);
      if (!listed.ok) return { ok: false, said: "GitHub didn't list your installations; connect it again" };
      const found = Array.isArray(listed.body?.installations) ? listed.body.installations : [];
      reachable = found.some((each) => String(each?.id) === installation);
      if (found.length < 100) break;
    }
  } finally {
    // The owner's own token was only needed to ask; it is revoked and never kept.
    const basic = btoa(`${app.clientId}:${app.clientSecret}`);
    await appJson(
      fetcher,
      `${GITHUB_API}/applications/${encodeURIComponent(app.clientId)}/token`,
      { method: "DELETE", headers: { ...githubHeaders(userToken), authorization: `Basic ${basic}`, "content-type": "application/json" }, body: JSON.stringify({ access_token: userToken }) },
      NAME,
    ).catch(() => null);
  }
  if (!reachable) return { ok: false, said: "That GitHub installation isn't one you can reach" };
  const minted = await installationToken({ app, installation, fetcher, nowMs });
  if (!minted.ok) return { ok: false, said: minted.said };
  return { ok: true, kept: { installation, repos: null } };
}

/** The installation's repositories, by full name: `{ok: true, repos: [{name, branch, private}]}` or `{ok: false, said, refused}`. */
export async function installationRepos({ token, fetcher }) {
  const repos = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const listed = await appJson(fetcher, `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, { headers: githubHeaders(token) }, NAME);
    if (!listed.ok) return { ok: false, refused: listed.status === 401 || listed.status === 403 || listed.status === 404, said: listed.said };
    const found = Array.isArray(listed.body?.repositories) ? listed.body.repositories : [];
    for (const repo of found) {
      const name = typeof repo?.full_name === "string" ? repo.full_name : "";
      if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(name)) continue;
      repos.push({ name, branch: typeof repo.default_branch === "string" ? repo.default_branch.slice(0, 200) : "main", private: repo.private === true });
    }
    if (found.length < 100) break;
  }
  return { ok: true, repos: repos.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The repositories a kept installation reads from, minting a token for the asking: `{ok, repos}` or `{ok: false, said, refused}`. */
export async function listGithubRepos({ kept, env, fetcher, now }) {
  const app = githubAppOf(env);
  if (app === null) return { ok: false, refused: false, said: "This deployment has no GitHub App set up" };
  const minted = await installationToken({ app, installation: kept?.installation, fetcher, nowMs: now });
  if (!minted.ok) return minted;
  return await installationRepos({ token: minted.token, fetcher });
}

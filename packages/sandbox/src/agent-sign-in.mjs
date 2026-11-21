#!/usr/bin/env node
/**
 * Lets an AI agent sign in to the preview of a pull request it opened, with no
 * mailbox and no new secret (Dev2, 2026-11-21: "What would be the best way for
 * AIs to authenticate themselves inside the PR that they just open?").
 *
 * 1. The agent makes a throwaway key pair on its own machine:
 *      node packages/sandbox/src/agent-sign-in.mjs keygen
 *    The private key stays in a file there; the public key is printed.
 * 2. It runs **Actions → Preview agent sign-in** (`preview-agent-sign-in.yml`)
 *    with the pull request number, a persona and that public key. The runner
 *    signs the persona in on that preview only (the preview deploy key CI
 *    already holds) and prints one `AGENT_SIGN_IN …` line: the preview's
 *    address and the session, sealed to the public key. The log is public;
 *    the line is unreadable without the private key.
 * 3. The agent pastes that line back:
 *      node packages/sandbox/src/agent-sign-in.mjs open "<line or whole log>"
 *    It writes a Playwright storage state (`browser.newContext({ storageState })`)
 *    holding the session where the web app keeps it, and prints the address.
 *    `open --shoot "/console"` also takes the desktop, medium and phone
 *    pictures itself (set CHROMIUM_PATH to use a Chromium of your own).
 *
 * Only the fixture personas, only a `pr<N>` preview deployment, never staging
 * or production: the runner holds only the preview deploy key. The sealing is
 * X25519 + HKDF-SHA256 + AES-256-GCM, all Node's own crypto.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PERSONAS } from "./sign-in-code.mjs";
import { findConvexPreview } from "./teardown.mjs";

export const LINE_TAG = "AGENT_SIGN_IN";
const INFO = Buffer.from("context preview agent sign-in v1");
/** DER prefix of an X25519 SubjectPublicKeyInfo; the raw 32 bytes follow it. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
export const DEFAULT_KEY_FILE = join(tmpdir(), "context-agent-sign-in.pem");

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

function publicKeyFromRaw(raw) {
  if (raw.length !== 32) throw new Error("The public key is 32 bytes of X25519, base64url.");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

const rawPublic = (key) => (key.type === "public" ? key : createPublicKey(key)).export({ format: "der", type: "spki" }).subarray(X25519_SPKI_PREFIX.length);

/** Parses the agent's public key: exactly 43 base64url characters, nothing else reaches crypto. */
export function parsePublicKey(text) {
  const value = String(text ?? "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("PUBLIC_KEY must be the 43-character key `agent-sign-in.mjs keygen` printed.");
  return publicKeyFromRaw(Buffer.from(value, "base64url"));
}

function aesKey(shared, ephemeralRaw, recipientRaw) {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, recipientRaw]), INFO, 32));
}

/** Seals `payload` (any JSON) to the recipient's X25519 public key. Returns the one printable line. */
export function seal(payload, recipientPublicKey) {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = rawPublic(ephemeral.publicKey);
  const recipientRaw = rawPublic(recipientPublicKey);
  const key = aesKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey }), ephemeralRaw, recipientRaw);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${LINE_TAG} v1.${b64url(ephemeralRaw)}.${b64url(nonce)}.${b64url(body)}`;
}

/** Finds the sealed line in `text` (the line itself, or a whole job log) and opens it with the private key. */
export function unseal(text, privateKey) {
  const match = new RegExp(`${LINE_TAG} v1\\.([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{16})\\.([A-Za-z0-9_-]+)`).exec(String(text ?? ""));
  if (match === null) throw new Error(`No ${LINE_TAG} line found.`);
  const [, ephemeralText, nonceText, bodyText] = match;
  const ephemeralRaw = Buffer.from(ephemeralText, "base64url");
  const recipientRaw = rawPublic(privateKey);
  const key = aesKey(diffieHellman({ privateKey, publicKey: publicKeyFromRaw(ephemeralRaw) }), ephemeralRaw, recipientRaw);
  const body = Buffer.from(bodyText, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceText, "base64url"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  try {
    return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("That line was not sealed to this key (run keygen again and use the new public key).");
  }
}

/** Where @convex-dev/auth keeps a session on the web: localStorage, namespaced by the Convex URL with everything but letters and digits removed. */
export function authStorageKeys(convexUrl) {
  const namespace = String(convexUrl).replace(/[^a-zA-Z0-9]/g, "");
  return { jwt: `__convexAuthJWT_${namespace}`, refresh: `__convexAuthRefreshToken_${namespace}` };
}

/** A Playwright storage state that opens `origin` signed in. */
export function storageState({ origin, convexUrl, token, refreshToken }) {
  const keys = authStorageKeys(convexUrl);
  return {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: keys.jwt, value: token }, { name: keys.refresh, value: refreshToken }] }],
  };
}

/** The session payload checks before the agent trusts it. */
function checkPayload(payload) {
  const origin = new URL(payload?.origin ?? "");
  if (origin.protocol !== "https:" || !/^context-router-pr[1-9][0-9]{0,6}\./.test(origin.hostname)) throw new Error("The sealed origin is not a preview router.");
  if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(payload.convexUrl ?? "")) throw new Error("The sealed Convex URL is not a deployment.");
  if (typeof payload.token !== "string" || typeof payload.refreshToken !== "string") throw new Error("The sealed session is incomplete.");
  return { ...payload, origin: origin.origin };
}

/** Signs the persona in through the Convex client, loaded only when it really runs. */
async function signInForReal({ convexUrl, deployment, deployKey, email }) {
  const [{ ConvexHttpClient }, { makeFunctionReference }, { issuePersonaCode }] = await Promise.all([
    import("convex/browser"),
    import("convex/server"),
    import("./seed.mjs"),
  ]);
  const code = issuePersonaCode(email, { deployment, deployKey });
  const client = new ConvexHttpClient(convexUrl, { logger: false });
  const result = await client.action(makeFunctionReference("auth:signIn"), { provider: "email", params: { email, code } });
  return result?.tokens ?? null;
}

/** CI: sign the persona in on pull request `PR`'s preview and print the session sealed to `PUBLIC_KEY`. */
export async function mint(env = process.env, { signIn = signInForReal, find = findConvexPreview, fetchImpl = fetch, log = console.log } = {}) {
  const pr = String(env.PR ?? "");
  if (!/^[1-9][0-9]{0,6}$/.test(pr)) throw new Error("PR must be a pull request number.");
  const persona = String(env.PERSONA ?? "");
  if (!PERSONAS.includes(persona)) throw new Error(`PERSONA must be one of ${PERSONAS.join(", ")}.`);
  const recipient = parsePublicKey(env.PUBLIC_KEY);
  const origin = new URL(String(env.PREVIEW_ROUTER_ORIGIN ?? ""));
  if (origin.protocol !== "https:" || !origin.hostname.startsWith(`context-router-pr${pr}.`)) throw new Error("PREVIEW_ROUTER_ORIGIN must be this pull request's preview router.");
  const deployKey = env.CONVEX_DEPLOY_KEY;
  if (typeof deployKey !== "string" || !deployKey.startsWith("preview:")) throw new Error("CONVEX_DEPLOY_KEY must be a preview deploy key.");
  const deployment = await find(deployKey, `pr${pr}`, { fetchImpl });
  if (deployment === null) throw new Error(`Pull request #${pr} has no preview deployment.`);
  const convexUrl = `https://${deployment}.convex.cloud`;
  const tokens = await signIn({ convexUrl, deployment, deployKey, email: `${persona}@supa.media` });
  if (!tokens?.token || !tokens?.refreshToken) throw new Error(`Signing ${persona} in on preview pr${pr} failed.`);
  log(seal({ v: 1, pr: Number(pr), persona, origin: origin.origin, convexUrl, token: tokens.token, refreshToken: tokens.refreshToken, issuedAt: new Date().toISOString() }, recipient));
  log(`Signed ${persona} in on preview pr${pr}. The line above is sealed to the key you passed; open it with agent-sign-in.mjs open.`);
}

/** Agent: make a throwaway key pair, keep the private half in `file`, print the public half. */
export function keygen(file = DEFAULT_KEY_FILE, { log = console.log } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const pub = b64url(rawPublic(publicKey));
  log(pub);
  return pub;
}

/** Agent: open the sealed line, write the storage state, optionally take the pictures. */
export async function open(text, { keyFile = DEFAULT_KEY_FILE, stateFile = join(tmpdir(), "context-agent-sign-in-state.json"), shoot, outDir = "screenshots", log = console.log } = {}) {
  const payload = checkPayload(unseal(text, createPrivateKey(readFileSync(keyFile))));
  writeFileSync(stateFile, JSON.stringify(storageState(payload)), { mode: 0o600 });
  log(`Signed in as ${payload.persona} on preview pr${payload.pr}.`);
  log(`Origin: ${payload.origin}`);
  log(`Playwright storage state: ${stateFile}`);
  if (shoot !== undefined) await takePictures(payload.origin, stateFile, shoot, outDir, log);
  return payload;
}

async function takePictures(origin, stateFile, spec, outDir, log) {
  const [{ chromium }, { LAYOUTS, parseShots }] = await Promise.all([import("playwright"), import("./screenshots.mjs")]);
  const shots = parseShots(spec);
  mkdirSync(outDir, { recursive: true });
  // CHROMIUM_PATH: a browser of the agent's own when the repository's Playwright has none downloaded.
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
  try {
    for (const layout of LAYOUTS) {
      const { name, width, height, ...rest } = layout;
      const context = await browser.newContext({ storageState: stateFile, viewport: { width, height }, deviceScaleFactor: 1, ...rest });
      const page = await context.newPage();
      for (const shot of shots) {
        await page.goto(new URL(shot.path, origin).href, { waitUntil: "networkidle" }).catch(() => {});
        for (const step of shot.steps) {
          if (step.kind === "click") await page.getByTestId(step.value).click();
          else if (step.kind === "key") await page.keyboard.press(step.value);
          else if (step.kind === "type") await page.keyboard.type(step.value);
          else await page.waitForTimeout(step.ms);
        }
        const file = join(outDir, `${shot.name}-${name}.png`);
        await page.screenshot({ path: file });
        log(`Saved ${file}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args.splice(index, 2)[1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  const run = async () => {
    if (command === "mint") return mint();
    const keyFile = flag(args, "--key") ?? DEFAULT_KEY_FILE;
    if (command === "keygen") return keygen(keyFile);
    if (command === "open") {
      const shoot = flag(args, "--shoot");
      const stateFile = flag(args, "--state");
      const outDir = flag(args, "--out");
      const text = args.length > 0 ? args.join(" ") : readFileSync(0, "utf8");
      return open(text, { keyFile, shoot, ...(stateFile ? { stateFile } : {}), ...(outDir ? { outDir } : {}) });
    }
    throw new Error("Usage: agent-sign-in.mjs keygen | open [--shoot SHOTS] [--state FILE] [--out DIR] <line> | mint");
  };
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

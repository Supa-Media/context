/**
 * A fake Google for the push suite: an RSA key pair standing in for Google's
 * ID-token signing key, a certs endpoint serving its public half, and a
 * signer for Pub/Sub push tokens. Every value is obviously fake; this
 * repository is public.
 */

import { vi } from "vitest";
import { GOOGLE_CERTS_URL, resetGoogleCertCache } from "../../functions/lib/googlePush/oidc";

export const SITE = "https://example-deployment.convex.site";
export const AUDIENCE = `${SITE}/google/push/pubsub`;
export const PUSH_ACCOUNT = "pubsub-push@example-project.iam.gserviceaccount.com";
export const TOPIC = "projects/example-project/topics/google-sync-push";

function base64Url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface FakeGoogleSigner {
  kid: string;
  certs: () => Response;
  sign: (claims: Record<string, unknown>, header?: Record<string, unknown>) => Promise<string>;
  certFetches: () => number;
  fetchImpl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}

export async function fakeGoogleSigner(kid = "example-kid-1"): Promise<FakeGoogleSigner> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  let fetches = 0;
  const certs = () =>
    new Response(JSON.stringify({ keys: [{ kid, kty: "RSA", alg: "RS256", use: "sig", n: publicJwk.n, e: publicJwk.e }] }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    });
  return {
    kid,
    certs,
    certFetches: () => fetches,
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url !== GOOGLE_CERTS_URL) throw new Error(`unrouted ${url}`);
      fetches += 1;
      return certs();
    },
    sign: async (claims, header = { alg: "RS256", kid, typ: "JWT" }) => {
      const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}

/** Claims as Pub/Sub sends them for our subscription. */
export function pushClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: PUSH_ACCOUNT,
    email_verified: true,
    iat: now - 5,
    exp: now + 3600,
    sub: "123456789012345678901",
    ...overrides,
  };
}

/** Push configured on this deployment, as production would have it. */
export function enablePush() {
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("GOOGLE_PUSH_TOPIC", TOPIC);
  vi.stubEnv("GOOGLE_PUSH_SERVICE_ACCOUNT", PUSH_ACCOUNT);
  resetGoogleCertCache();
}

/** A Pub/Sub push body around Gmail's notification. */
export function gmailDelivery(emailAddress: string): string {
  return JSON.stringify({
    message: {
      data: btoa(JSON.stringify({ emailAddress, historyId: "9876543210" })),
      messageId: "example-message-id",
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/example-project/subscriptions/google-sync-push",
  });
}

/** A Pub/Sub push body around a Workspace Events CloudEvent. */
export function chatDelivery(subscriptionName: string, type = "google.workspace.chat.message.v1.created"): string {
  return JSON.stringify({
    message: {
      attributes: {
        "ce-type": type,
        "ce-source": `//workspaceevents.googleapis.com/${subscriptionName}`,
        "ce-subject": "//chat.googleapis.com/spaces/alpha/messages/msg-1",
      },
      data: btoa(JSON.stringify({ message: { name: "spaces/alpha/messages/msg-1" } })),
      messageId: "example-message-id",
    },
    subscription: "projects/example-project/subscriptions/google-sync-push",
  });
}

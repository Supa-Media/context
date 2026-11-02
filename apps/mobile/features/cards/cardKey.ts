/**
 * The card key, as the app leaves it for its Messages extension.
 *
 * The extension (`targets/context-messages/CardGrant.swift`) reads one item
 * from the keychain of the app's group, `group.<bundle id>`, which only the
 * app and its extensions can open, and it alone refreshes it from then on. So
 * the app writes the key only where there is none, and deletes it at sign-out;
 * it never refreshes it, because two holders rotating one refresh token is a
 * reuse the gateway answers by revoking the key.
 *
 * The layout is expo-secure-store's for key `grant` in service
 * `lc.context.cards`, which the Swift reads as `lc.context.cards:no-auth`.
 */

export const CARD_KEY_NAME = "grant";
export const CARD_KEY_SERVICE = "lc.context.cards";
/** This phone's id for its key, kept in the app's own keychain (not shared). */
export const CARD_DEVICE_NAME = "lc.context.cards.device";

export type MintedCardKey = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

/** The app group the extension shares, or null without a bundle id. */
export function cardKeyGroup(bundleIdentifier: string | null | undefined): string | null {
  return bundleIdentifier ? `group.${bundleIdentifier}` : null;
}

/**
 * The item the extension reads, or null when the gateway's address is not an
 * https URL (a misconfigured self-host gets no key rather than a guessed one).
 * `api` is the gateway's origin; the extension adds `/cards/…` to it.
 */
export function cardKeyRecord(minted: MintedCardKey, mcpEndpoint: string, workspaceId: string): string | null {
  let origin: string;
  try {
    const url = new URL(mcpEndpoint);
    if (url.protocol !== "https:") return null;
    origin = url.origin;
  } catch {
    return null;
  }
  return JSON.stringify({
    api: origin,
    token: `${origin}/oauth/token`,
    clientId: minted.clientId,
    accessToken: minted.accessToken,
    expiresAt: minted.expiresAt,
    refreshToken: minted.refreshToken,
    // Whose it is, so another account signing in on this phone replaces it (the extension ignores it).
    workspaceId,
  });
}

/** Whether a stored key belongs to this workspace; anything unreadable does not. */
export function cardKeyIsFor(stored: string | null, workspaceId: string): boolean {
  if (stored === null) return false;
  try {
    return (JSON.parse(stored) as { workspaceId?: unknown }).workspaceId === workspaceId;
  } catch {
    return false;
  }
}

/** A fresh id for this phone's key: letters, digits and dashes, as the mint requires. */
export function newDeviceId(random: () => string = () => globalThis.crypto?.randomUUID?.() ?? ""): string {
  const id = random();
  if (/^[a-zA-Z0-9-]{8,64}$/.test(id)) return id;
  return `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

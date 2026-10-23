/**
 * WHO IS TEXTING TEX, ON EVERY TURN IT ANSWERS FOR ONE PERSON.
 *
 * Decided by the owner (Dev2), 2026-10-23. Signing him in to Partiful, Tex
 * texted "your number isn't anywhere in your notes. What's the number on your
 * Partiful account?" — to the number it was texting. A phone number, a name
 * and an email are account facts, not notes, so no search could find them:
 * the control plane's (`/gateway/agent/identity`) are put in the system
 * prompt instead, and Tex uses them for any sign-in or form without asking.
 *
 * Only the grant's own person, only for Tex's one-person clients (texts,
 * routines, check-ins): a group chat is several people and is told nothing.
 * Best effort: a turn without it knows less, it never fails.
 */

/** Bounds on what is said, whatever the control plane sends. */
const MAX_ITEMS = 10;
const MAX_FIELD = 200;

function text(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_FIELD && !/[\r\n]/.test(value) ? value.trim() : null;
}

function list(value) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, MAX_ITEMS);
}

/** The control plane's answer, checked field by field, or null. */
export function readIdentity(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const google = (Array.isArray(raw.google) ? raw.google : [])
    .map((account) => ({ address: text(account?.address), products: list(account?.products) }))
    .filter((account) => account.address !== null)
    .slice(0, MAX_ITEMS);
  const identity = { name: text(raw.name), handle: text(raw.handle), phones: list(raw.phones), emails: list(raw.emails), google };
  const known = identity.name || identity.handle || identity.phones.length > 0 || identity.emails.length > 0;
  return known ? identity : null;
}

/** Who this session's person is, or null. Never throws. */
export async function texterIdentity(controlPlane, session) {
  try {
    if (typeof controlPlane?.texterIdentity !== "function") return null;
    return readIdentity(await controlPlane.texterIdentity(session.accessToken, session.workspaceId));
  } catch {
    return null;
  }
}

const PRODUCT_NAMES = { gmail: "Gmail", calendar: "Calendar", chat: "Google Chat" };

/** What the system prompt says about them, or "" when nothing is known. */
export function identityPrompt(identity) {
  if (identity === null || typeof identity !== "object") return "";
  const [phone, ...otherPhones] = identity.phones ?? [];
  const lines = [
    ...(identity.name ? [`- Name: ${identity.name}`] : []),
    ...(phone ? [`- Phone: ${phone} (the number you text them at)${otherPhones.length > 0 ? `; also ${otherPhones.join(", ")}` : ""}`] : []),
    ...((identity.emails ?? []).length > 0 ? [`- Email: ${identity.emails.join(", ")}`] : []),
    ...((identity.google ?? []).length > 0
      ? [`- Google accounts connected to you: ${identity.google.map(({ address, products }) => (products.length > 0 ? `${address} (${products.map((product) => PRODUCT_NAMES[product] ?? product).join(", ")})` : address)).join("; ")}`]
      : []),
    ...(identity.handle ? [`- Context handle: @${identity.handle}`] : []),
  ];
  if (lines.length === 0) return "";
  return [
    "",
    "",
    "Who they are, from their Context account (as sure as anything they told you):",
    ...lines,
    "When a site, form or sign-in asks for their name, phone number or email, use these: never ask them for one of them, and never say it isn't in their notes. " +
      "A code a site sends to that phone or email is the one thing to ask them for (or find it in their email).",
  ].join("\n");
}

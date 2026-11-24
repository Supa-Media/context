/**
 * The only paths the Worker forwards. Anything else is a 404 before the
 * Durable Object is woken. The list mirrors container/validate.mjs (OPS) and
 * container/app.mjs; a test keeps the two in step.
 */

export const OP_PATHS = [
  "send/text",
  "send/attachment",
  "send/multipart",
  "send/app",
  "edit",
  "unsend",
  "react",
  "typing",
  "read",
  "contact",
  "chat/resolve",
  "group/members",
  "group/remove",
  "poll/create",
] as const;

const OPS = new Set<string>(OP_PATHS);
const ATTACHMENT = /^\/attachment\/[^/]+$/;

export function isBridgeRoute(method: string, pathname: string): boolean {
  if (method === "GET") {
    return pathname === "/health" || pathname === "/ready" || ATTACHMENT.test(pathname);
  }
  if (method === "POST") {
    return pathname.startsWith("/") && OPS.has(pathname.slice(1));
  }
  return false;
}

/**
 * What the gateway may ask of Tex's computer, checked before anything reaches an object: one of four operations, for
 * one computer named by its owner tag (an HMAC the gateway makes from a person's or a chat's id, `browserProviders.js`
 * `browserOwner`; it names nobody), with a body the container caps again.
 */
export const OPS = ["run", "read", "write", "list", "stop"] as const;
export type Op = (typeof OPS)[number];

const OWNER = /^[0-9a-f]{64}$/;

export type Asked = { op: Op; owner: string; input: Record<string, unknown> };

/** The parsed request, or a refusal with its status. */
export function parseAsk(method: string, pathname: string, body: unknown): Asked | { status: number; error: string } {
  if (method !== "POST") return { status: 405, error: "POST only" };
  const match = /^\/computer\/([a-z]+)$/.exec(pathname);
  const op = match?.[1] as Op | undefined;
  if (!op || !(OPS as readonly string[]).includes(op)) return { status: 404, error: "unknown operation" };
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "a JSON object" };
  const { owner, ...input } = body as Record<string, unknown>;
  if (typeof owner !== "string" || !OWNER.test(owner)) return { status: 400, error: "owner must be a computer's tag" };
  return { op, owner, input };
}

/** Each computer's object name: one per owner tag, never shared. */
export const objectName = (owner: string) => `computer:${owner}`;

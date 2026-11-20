/** The answer's `invite` (`groupInvite.ts`); no imports, so `clients.ts` and `groupInvite.ts` both read it. */

/** A group's people invited to a workspace after the answer (`groupInvite.ts`, the gateway's `chat_add_everyone`). */
export type ChatInvite = { slug: string; role: "editor" | "member" };

/** The answer's `invite`, or null for anything else. */
export function readInvite(value: unknown): ChatInvite | null {
  if (value === null || typeof value !== "object") return null;
  const { slug, role } = value as { slug?: unknown; role?: unknown };
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) return null;
  return { slug, role: role === "member" ? "member" : "editor" };
}

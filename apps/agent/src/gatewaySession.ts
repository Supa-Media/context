/**
 * A text's session from the person object, without Convex (`docs/decisions/texting-assistant/texting-in-objects.md`):
 * the gateway's `TexTexts` entrypoint over a service binding (`apps/mcp/src/agent/textsSession.js`), and the inbox's
 * memory of whose phone it answers. Also how any session answer is read, the gateway's or Convex's (`clients.ts`).
 */

import { readSettings, type Settings } from "./texStyle";

export type LinkedSession = { status: "linked"; accessToken: string; timeZone?: string; settings?: Settings; personalWorkspaceId?: string };

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A linked session answer, checked field by field, or `null`. */
export function linkedFrom(body: Record<string, unknown>): LinkedSession | null {
  if (body.status !== "linked" || typeof body.accessToken !== "string" || !body.accessToken) return null;
  const zone = typeof body.timeZone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(body.timeZone) ? { timeZone: body.timeZone } : {};
  const settings = readSettings(body);
  const own = typeof body.personalWorkspaceId === "string" && WORKSPACE_ID.test(body.personalWorkspaceId) ? { personalWorkspaceId: body.personalWorkspaceId } : {};
  return { status: "linked", accessToken: body.accessToken, ...zone, ...(Object.keys(settings).length > 0 ? { settings } : {}), ...own };
}

/** The gateway's `TexTexts` entrypoint, reached over a service binding. */
export type TextsBinding = { fetch: (input: string, init?: RequestInit) => Promise<Response> };

/**
 * The phone and the personal workspace id this inbox remembers. Anything but a linked answer, a failure included, is
 * `null`, and the caller asks Convex as before.
 */
export async function openGatewaySession(binding: TextsBinding, phone: string, personalWorkspaceId: string): Promise<LinkedSession | null> {
  try {
    const response = await binding.fetch("https://gateway/texts/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, personalWorkspaceId }),
    });
    if (response.status !== 200) return null;
    const linked = linkedFrom(recordOf(await response.json()));
    return linked === null ? null : { ...linked, personalWorkspaceId };
  } catch {
    return null;
  }
}

/** Whose phone this inbox answers: the personal workspace id a session named, kept for the next text (`reply.ts` `textSession`). */
export const TEXTS_WORKSPACE_KEY = "texts:workspace";

type KeptStorage = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<boolean> };

/** A one-on-one inbox's texts session deps (`reply.ts` `TextsSessionDeps`): the binding, and its storage's memory. */
export function textsSessionDeps(binding: TextsBinding, storage: KeptStorage) {
  return {
    binding,
    workspaceId: async (): Promise<string | undefined> => {
      const kept = await storage.get<string>(TEXTS_WORKSPACE_KEY);
      return typeof kept === "string" ? kept : undefined;
    },
    remember: async (id: string | null): Promise<void> => {
      if (id === null) await storage.delete(TEXTS_WORKSPACE_KEY);
      else await storage.put(TEXTS_WORKSPACE_KEY, id);
    },
  };
}

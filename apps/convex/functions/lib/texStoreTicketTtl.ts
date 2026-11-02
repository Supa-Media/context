/**
 * How long one Tex store ticket opens its workspace's objects (`texStoreTickets.ts`). A plain module of its own so
 * the workspace object's door (`workspaceObjects/door.ts`), which queries and mutations reach through the note-fact
 * readers, does not load a module of registered functions mid-import.
 */
export const TEX_STORE_TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * A person's test chats, as the Lab's Recent list and `tex_dev test_chat list` show them (moved out of `route.js`,
 * 2026-11-27, to keep that file under its size threshold). `view` and `indexStub` are the route's own.
 */

import { callSandbox, SANDBOX_TTL_MS, sandboxStub } from "./object.js";

/** How many test chats `list` answers, newest used first. */
const LISTED = 20;

/**
 * `list`: the person's test chats from the last day, newest used first, each with who opened it and who last used it
 * (the Lab, or an AI through `tex_dev` on the person's grant), the draft it runs, its size and the text running now, so
 * the Lab follows a test chat an AI is driving and the AI one the person is (Dev2, 2026-11-16: "if I go into a
 * session/draft an AI is updating / editing, we can co work, and when its playing something I can see it playing").
 */
export async function listOf(env, userId, { view, indexStub }) {
  const index = await callSandbox(indexStub(env, userId), "state", {}).catch(() => null);
  const meta = index?.meta ?? {};
  const since = Date.now() - SANDBOX_TTL_MS;
  const opened = Object.entries(meta)
    .filter(([key, value]) => key.startsWith("sb:") && value && typeof value === "object")
    .map(([, value]) => ({ ...value, used: meta[`used:${value.sandboxId}`] ?? null }))
    .filter((chat) => Math.max(chat.at ?? 0, chat.used?.at ?? 0) >= since)
    .sort((a, b) => Math.max(b.at ?? 0, b.used?.at ?? 0) - Math.max(a.at ?? 0, a.used?.at ?? 0))
    .slice(0, LISTED);
  const chats = [];
  for (const chat of opened) {
    const state = await callSandbox(sandboxStub(env, userId, chat.sandboxId), "state", {}).catch(() => null);
    if (!state?.meta?.chat) continue;
    const seen = view(state);
    const last = seen.rows.at(-1) ?? null;
    chats.push({
      sandboxId: chat.sandboxId,
      source: chat.source,
      kind: chat.kind,
      chat: chat.chat,
      versionId: state.meta.chat.versionId ?? "main",
      ...(state.meta.chat.remote ? { code: `#${state.meta.chat.remote.pr}` } : {}),
      openedBy: chat.by ?? "Lab",
      openedAt: chat.at,
      ...(chat.used ? { lastBy: chat.used.by ?? "Lab", lastAt: chat.used.at } : {}),
      rows: seen.rows.length,
      testRows: seen.rows.filter((row) => !row.prod).length,
      running: seen.running,
      ...(last ? { last: { who: last.who, text: String(last.text ?? "").slice(0, 120) } } : {}),
    });
  }
  return { chats };
}

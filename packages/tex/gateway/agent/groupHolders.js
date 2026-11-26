/**
 * WHO HERE CAN OPEN A WORKSPACE THE CHAT NAMED (Dev2's privacy rulebook, rule 2, 2026-11-25;
 * `docs/decisions/texting-assistant/asker-reach.md`).
 *
 * A group turn reads only the asker's own workspaces, so when someone asks about one they are not in, the turn reads
 * nothing of it. The rulebook asks for "a neutral boundary naming who holds the keys" ("Seyi or Sayo can pull it up"),
 * never feigned ignorance. This is the missing fact, as data: for one workspace the turn names, the handles of the
 * people in this chat who are members there (`controlPlane.workspaceHolders`, `lib/texIdentity/holders.ts`). It lists
 * no workspace by itself, and one nobody here is in answers the same as one that does not exist. What Tex then says,
 * and whether to say it, is Training's (rulebook: code guards what a turn can read, Training what it says).
 */

export const WORKSPACE_HOLDERS = "workspace_holders";

/** The `send` action it is shown as (`sixTools.js`). */
export const HOLDERS_SEND_ACTIONS = {
  who_can_open: { tool: WORKSPACE_HOLDERS, summary: "Who here is in a workspace the chat named, by @handle or name." },
};

/** Most lookups one turn makes: a turn needs one or two, never a sweep. */
const MAX_CALLS = 3;

function data(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

/**
 * The tool for one group turn, or null outside a group chat or with no way to ask. `holders(workspace)` is
 * `controlPlane.workspaceHolders` on this turn's own token.
 */
export function holdersTool({ group, holders }) {
  if (group === null || group === undefined || typeof holders !== "function") return null;
  let calls = 0;
  return {
    tool: {
      name: WORKSPACE_HOLDERS,
      description:
        "Who in this group chat is a member of one shared workspace the chat named, so you know who here could open it. " +
        "workspace: its @handle or its name as said. Returns { workspace, holders: [@handle] }; workspace null when nobody here is in one by that name.",
      inputSchema: { type: "object", properties: { workspace: { type: "string" } }, required: ["workspace"], additionalProperties: false },
    },
    call: async (args) => {
      const asked = typeof args?.workspace === "string" ? args.workspace.trim().slice(0, 80) : "";
      if (asked === "") return data({ error: "workspace_required" }, true);
      if (calls >= MAX_CALLS) return data({ error: "too_many_lookups", limit: MAX_CALLS }, true);
      calls += 1;
      const answer = await Promise.resolve(holders(asked)).catch(() => null);
      if (answer === null || typeof answer !== "object") return data({ error: "unavailable" }, true);
      const slug = typeof answer.slug === "string" ? answer.slug : null;
      const handles = (Array.isArray(answer.holders) ? answer.holders : []).filter((handle) => typeof handle === "string").map((handle) => `@${handle}`);
      console.log(JSON.stringify({ event: "group_holders_read", found: slug !== null, holders: handles.length }));
      return data({ workspace: slug === null ? null : `@${slug}`, holders: slug === null ? [] : handles });
    },
  };
}

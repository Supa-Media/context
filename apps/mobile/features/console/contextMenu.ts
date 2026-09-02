import type { ConsoleRoute } from "./nav";

/**
 * What right-clicking a context in the rail offers.
 *
 * Seyi's ask, verbatim: "we can access settings for a context by
 * right-clicking it … because the top right little Dropbox button just isn't
 * very visible." The storage pill is real but it is one small control in a
 * corner; the rail entry is the thing a person already knows is *the
 * context*, so the context's verbs belong on it too.
 *
 * Three items, every one an existing destination:
 *
 *  - **Open** — what a left click already does, present so the menu's first
 *    entry is never a surprise.
 *  - **Settings…** — the context's own pane: storage binding, email
 *    ingestion. The ellipsis is the menu convention for "leads somewhere".
 *  - **Manage sharing…** — who has access lives in Connections
 *    (`MembersSection` is mounted there, because "who can reach this" is an
 *    access question, not a storage one), so that is where the item honestly
 *    goes. When sharing moves into per-context settings, this row follows it
 *    by changing one route here.
 *
 * A pure function over the slug rather than markup in the rail, so the menu's
 * contents are testable without a renderer and the rail only draws.
 */
export interface ContextMenuItem {
  key: "open" | "settings" | "sharing" | "leave";
  label: string;
  /** Absent on `leave`, which is an action on the membership, not a place. */
  route?: ConsoleRoute;
}

export function contextMenuItems(
  slug: string,
  options: {
    /**
     * True when the caller is **not** this context's owner — the only case in
     * which **Leave** appears. An owner walking out of their own context is an
     * ownership transfer wearing a different name, and the server refuses it
     * (`OWNER_CANNOT_LEAVE`), so the menu does not offer it. The door out of an
     * invitation, though, has to open from the invitee's side — before this,
     * getting out meant asking the owner to evict you.
     *
     * **Named for the role, not for the rail section it used to come from.**
     * This was `shared`, filled in from whether the row sat under "Shared with
     * you", which was the same answer by coincidence of that grouping. The rail
     * now groups on *kind*, where every workspace is shared and some of them
     * are yours — so a section-derived answer would have offered Leave on a
     * workspace you own, and the button would have come back
     * `OWNER_CANNOT_LEAVE`. The role is the fact the server enforces, so the
     * role is what this takes.
     */
    canLeave?: boolean;
  } = {},
): ContextMenuItem[] {
  return [
    { key: "open", label: "Open", route: { kind: "context", slug, view: "browse" } },
    { key: "settings", label: "Settings…", route: { kind: "context", slug, view: "settings" } },
    { key: "sharing", label: "Manage sharing…", route: { kind: "app", section: "connections" } },
    ...(options.canLeave
      ? [{ key: "leave" as const, label: `Leave @${slug}…` }]
      : []),
  ];
}

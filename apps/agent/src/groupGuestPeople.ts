/**
 * A guest chat's people, kept in step as they join and leave, whether or not
 * anyone tags Tex (the owner, 2026-10-27: "would like people to be
 * automatically added/removed when they join or leave a chat";
 * `docs/decisions/texting-assistant/group-guests.md`).
 *
 * A tag already brings the chat's group and folder in line with who is in it.
 * Between tags, every message in the chat names who is in it, and when that
 * list changed since the control plane last heard it, it is sent on
 * (`POST /agent-texts/group/people`). Nothing is minted and nothing is said in
 * the chat. Only a chat whose last turn answered as a guest chat sends it, so
 * an ordinary chat costs nothing; the control plane decides again anyway.
 */

import { post, type Fetch } from "./clients";
import { peopleKey } from "./groupChat";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

/** Set while the chat's last turn answered as a guest chat. */
const GUEST_KEY = "gguest";
/** The hash of the webhook's list the control plane last heard for this chat. */
const SYNCED_KEY = "gguestpeople";

type PeopleDeps = { fetch: Fetch; controlPlaneOrigin: string; workerSecret: string };

/** After a turn: whether the chat is a guest chat, and the people that turn named the control plane, which synced them. */
export async function noteGuestChat(storage: InboxStorage, message: GroupMessage, guest: boolean): Promise<void> {
  if (!guest) {
    await storage.delete(GUEST_KEY);
    await storage.delete(SYNCED_KEY);
    return;
  }
  await storage.put(GUEST_KEY, true);
  await storage.put(SYNCED_KEY, await peopleKey(message));
}

/** Any message in a guest chat whose people changed: the new list goes to the control plane. Never throws. */
export async function syncGuestPeople(storage: InboxStorage, deps: PeopleDeps, message: GroupMessage): Promise<void> {
  // An SMS group is never a guest chat, and a routine's run is this Worker's own.
  if (message.sms || message.routine !== undefined) return;
  if ((await storage.get<boolean>(GUEST_KEY)) !== true) return;
  const key = await peopleKey(message);
  if ((await storage.get<string>(SYNCED_KEY)) === key) return;
  try {
    const { status } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/group/people`, deps.workerSecret, {
      line: message.line,
      groupId: message.groupId,
      participants: message.participants,
    });
    if (status === 200) await storage.put(SYNCED_KEY, key);
    log(status === 200 ? "synced" : "refused");
  } catch {
    // The next message tries again: nothing was marked heard.
    log("unreachable");
  }
}

/** One line per outcome, never a number or a name. */
function log(outcome: string): void {
  console.log(JSON.stringify({ event: "group_guest_people", outcome }));
}

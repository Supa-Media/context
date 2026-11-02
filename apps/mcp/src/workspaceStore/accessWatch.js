/**
 * Joins a workspace object's member tables to the app's access socket
 * (`accessSockets.js`, `accessTopics.js`): registers what the socket serves,
 * and tells it whenever members, invitations or the access home change,
 * through any door (the socket's own writes, the control plane's, a copy).
 *
 * A member removed has every socket they hold here closed at once, so they
 * reconnect through the gateway and this object refuses them (`admit`).
 */

import { createControlPlane } from "../controlPlane.js";
import { workspaceAccessTopics } from "./accessTopics.js";

const TOPICS = { members: ["members"], invites: ["invites"] };

export function watchMembers(store, access, env, deps = {}) {
  const members = store.members;
  if (!members) return;
  const profilesFor =
    deps.profilesFor ??
    (() => {
      try {
        const controlPlane = createControlPlane(env);
        return typeof controlPlane.profilesFor === "function" ? (people) => controlPlane.profilesFor(people) : undefined;
      } catch {
        // A deployment without a control plane serves no names, so the members topic stays on Convex.
        return undefined;
      }
    })();
  access.provide(workspaceAccessTopics(store, { profilesFor, mirror: deps.mirror }));

  const put = members.put.bind(members);
  const remove = members.remove.bind(members);
  const snapshot = members.snapshot.bind(members);
  const setHome = members.setHome.bind(members);
  members.put = (name, rows) => {
    const kept = put(name, rows);
    access.changed(TOPICS[name] ?? null);
    return kept;
  };
  members.remove = (name, keys, at) => {
    const removed = remove(name, keys, at);
    if (name === "members") for (const userId of removed) access.lockOut(userId);
    access.changed(TOPICS[name] ?? null);
    return removed;
  };
  members.snapshot = (name, fields) => {
    const result = snapshot(name, fields);
    // A whole copy can drop anyone: every socket is decided again by `admit` on its next frame, and re-sent now.
    if (result?.swapped && name === "members") {
      for (const userId of access.readers()) if (members.member(userId) === null) access.lockOut(userId);
    }
    access.changed(TOPICS[name] ?? null);
    return result;
  };
  members.setHome = (home) => {
    const held = setHome(home);
    access.changed();
    return held;
  };
}

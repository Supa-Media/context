/**
 * Each workspace's change signal from its own object (`objectHeads.ts`), the cue a device's copy catches up on
 * instead of the control plane's change log (decided by the owner, 2026-11-06).
 *
 * Sabotage record (2026-11-06): dropping `head: true` from the socket `objectHeads` opens fails "a socket asks only
 * for the head"; dropping the `changed(workspaceId, null)` on `onServed(false)` fails "a workspace its object does not
 * serve goes back to the control plane's log".
 */

import { describe, expect, test } from "@jest/globals";
import { OBJECT_HEAD, objectHeads, type OpenTree } from "../features/offline/objectHeads";

function harness() {
  const opened: Array<{ workspaceId: string; head?: boolean; watched: string[][]; closed: boolean; onHead?: (token: string) => void; onServed: (served: boolean) => void }> = [];
  const changes: Array<[string, string | null]> = [];
  const open: OpenTree = (options) => {
    const socket = { workspaceId: options.workspaceId, head: options.head, watched: [] as string[][], closed: false, onHead: options.onHead, onServed: options.onServed };
    opened.push(socket);
    return {
      watch: (folders) => void socket.watched.push([...folders]),
      close: () => void (socket.closed = true),
    };
  };
  const heads = objectHeads(open, (workspaceId, head) => changes.push([workspaceId, head]));
  return { heads, opened, changes };
}

describe("a workspace's change signal from its object", () => {
  test("a socket asks only for the head, one per workspace", () => {
    const h = harness();
    h.heads.follow(["w1", "w2"]);
    expect(h.opened.map((socket) => [socket.workspaceId, socket.head, socket.watched])).toEqual([
      ["w1", true, [[]]],
      ["w2", true, [[]]],
    ]);
    h.heads.follow(["w1", "w2"]);
    expect(h.opened).toHaveLength(2);
  });

  test("each head the object pushes is that workspace's token, never equal to a control-plane one", () => {
    const h = harness();
    h.heads.follow(["w1"]);
    h.opened[0].onHead?.("ab12");
    h.opened[0].onHead?.("cd34");
    expect(h.changes).toEqual([
      ["w1", `${OBJECT_HEAD}ab12`],
      ["w1", `${OBJECT_HEAD}cd34`],
    ]);
  });

  test("a workspace its object does not serve goes back to the control plane's log", () => {
    const h = harness();
    h.heads.follow(["w1"]);
    h.opened[0].onHead?.("ab12");
    h.opened[0].onServed(false);
    expect(h.changes.at(-1)).toEqual(["w1", null]);
  });

  test("a workspace no longer followed is closed and forgotten; closing closes every socket", () => {
    const h = harness();
    h.heads.follow(["w1", "w2"]);
    h.heads.follow(["w2"]);
    expect(h.opened[0].closed).toBe(true);
    expect(h.changes).toEqual([["w1", null]]);
    h.heads.close();
    expect(h.opened[1].closed).toBe(true);
  });
});

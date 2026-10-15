/**
 * **"I rename and start typing but the rename doesnt actually propogate until
 * later and as such it deletes everything i typed already"** (owner,
 * 2026-10-14).
 *
 * A note renamed while it is open keeps its controller: the same document and
 * queue, sent to the new name. Nothing is sent or read while the gateway is
 * moving it.
 */
import { describe, expect, test } from "@jest/globals";
import { memoryStore } from "../features/offline/memory";
import { createSharedDoc } from "../features/console/presence/sharedDoc";
import { DurableCollaborationController, type CollaborationResponse } from "../features/console/collaboration/durable";

type Body = { path: string; documentId?: string; update?: string };

function snapshot(text: string): string {
  const doc = createSharedDoc({});
  doc.doc.transact(() => doc.text.insert(0, text), "server");
  const result = doc.snapshot();
  doc.destroy();
  return result;
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 20));

function controllerAt(path: string) {
  const sent: Body[] = [];
  const store = memoryStore();
  const base = snapshot("# Plan\n\nBody.");
  const controller = new DurableCollaborationController({
    workspaceId: "workspace",
    path,
    scope: "private",
    initialText: "",
    store,
    online: () => true,
    onText: () => {},
    onState: () => {},
    transport: {
      mint: async () => "grant",
      request: async (_token, body: Body): Promise<CollaborationResponse> => {
        sent.push(body);
        return { documentId: "doc-1", update: base, text: "# Plan\n\nBody.", etag: "c2.1" };
      },
    },
  });
  return { controller, sent, store };
}

describe("a note renamed while it is open", () => {
  test("typing during the rename is held, then sent to the new name, by the same document", async () => {
    const { controller, sent, store } = controllerAt("notes/plan.md");
    await controller.start();
    const shared = controller.state.shared;
    sent.length = 0;

    controller.hold();
    controller.state.onChange("# Plan\n\nBody. And more");
    controller.repairForHook();
    await flushed();
    // Nothing reaches a note the gateway is moving.
    expect(sent).toEqual([]);
    expect(controller.state.pending).toBe(1);

    controller.retarget("notes/Roadmap.md");
    await flushed();
    expect(controller.path).toBe("notes/Roadmap.md");
    expect(sent.map((body) => body.path)).toEqual(["notes/Roadmap.md"]);
    expect(sent[0]!.update).toBeDefined();
    expect(controller.state.shared).toBe(shared);
    expect(controller.state.text).toBe("# Plan\n\nBody. And more");
    // The device's copy moved with it: nothing left under the old name.
    const keys = await store.keys();
    expect(keys.some((key) => key.includes("plan.md"))).toBe(false);
    expect(keys.some((key) => key.includes("Roadmap.md"))).toBe(true);
    controller.stop();
  });

  test("a refused rename lets go, and the typing goes to the name the note kept", async () => {
    const { controller, sent } = controllerAt("notes/plan.md");
    await controller.start();
    sent.length = 0;
    controller.hold();
    controller.state.onChange("# Plan\n\nBody. Kept");
    await flushed();
    expect(sent).toEqual([]);
    controller.release();
    await flushed();
    expect(sent.map((body) => body.path)).toEqual(["notes/plan.md"]);
    controller.stop();
  });
});

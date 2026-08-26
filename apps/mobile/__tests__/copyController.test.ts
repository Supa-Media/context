import { describe, expect, test } from "@jest/globals";
import { COPY_RESET_MS, createCopyController } from "../features/design/copyController";

/**
 * A fake clock, so the "Copied" window is asserted rather than slept through.
 */
function makeClock() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let now = 0;

  return {
    schedule(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    cancel(id: number) {
      pending.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, task] of [...pending.entries()]) {
        if (task.at <= now) {
          pending.delete(id);
          task.fn();
        }
      }
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function setup(write: (text: string) => Promise<boolean>) {
  const clock = makeClock();
  const labels: string[] = [];
  const controller = createCopyController<number>({
    text: "https://mcp.context.lc/mcp",
    write,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onLabelChange: (label) => labels.push(label),
  });
  return { clock, labels, controller };
}

describe("copy controller", () => {
  test("starts at rest", () => {
    const { controller, labels } = setup(async () => true);
    expect(controller.label).toBe("Copy");
    expect(labels).toEqual([]);
  });

  test("writes the exact text it was given", async () => {
    const written: string[] = [];
    const { controller } = setup(async (text) => {
      written.push(text);
      return true;
    });
    await controller.copy();
    expect(written).toEqual(["https://mcp.context.lc/mcp"]);
  });

  test("confirms, then goes back to rest after the reset window", async () => {
    const { controller, clock, labels } = setup(async () => true);

    await controller.copy();
    expect(controller.label).toBe("Copied");

    clock.advance(COPY_RESET_MS - 1);
    expect(controller.label).toBe("Copied");

    clock.advance(1);
    expect(controller.label).toBe("Copy");
    expect(labels).toEqual(["Copied", "Copy"]);
  });

  test("a refused clipboard never claims success", async () => {
    const { controller, clock } = setup(async () => false);

    await controller.copy();
    expect(controller.label).not.toBe("Copied");
    expect(controller.label).toBe("Press ⌘C");

    clock.advance(COPY_RESET_MS);
    expect(controller.label).toBe("Copy");
  });

  test("a second copy restarts the window instead of stacking timers", async () => {
    const { controller, clock } = setup(async () => true);

    await controller.copy();
    clock.advance(COPY_RESET_MS - 200);
    await controller.copy();
    expect(clock.pendingCount).toBe(1);

    // The first timer would have fired here had it survived.
    clock.advance(200);
    expect(controller.label).toBe("Copied");

    clock.advance(COPY_RESET_MS);
    expect(controller.label).toBe("Copy");
  });

  test("dispose cancels the pending reset so an unmounted field cannot set state", async () => {
    const { controller, clock } = setup(async () => true);
    await controller.copy();
    expect(clock.pendingCount).toBe(1);
    controller.dispose();
    expect(clock.pendingCount).toBe(0);
  });

  test("does not emit a change when the label would not actually change", async () => {
    const { controller, clock, labels } = setup(async () => true);
    await controller.copy();
    clock.advance(COPY_RESET_MS);
    labels.length = 0;
    // Back at rest; copying again should announce exactly one transition.
    await controller.copy();
    expect(labels).toEqual(["Copied"]);
  });
});

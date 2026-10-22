/**
 * The embedded frames of a Browserbase page, over raw CDP (./frames.ts says
 * why). Two kinds:
 *
 * - **A frame from another site** runs in its own process: its own CDP
 *   target, attached here once per connection (`Target.setAutoAttach` on the
 *   page reports each one) and evaluated on that session.
 * - **A frame on the same site** shares its parent's process: evaluated in an
 *   isolated world of its own (`Page.createIsolatedWorld`), which sees the
 *   frame's document but none of its scripts' variables.
 *
 * Where a frame shows on the screen comes from the box of the `<iframe>` that
 * holds it (`DOM.getFrameOwner`, `DOM.getBoxModel`), added up through every
 * frame around it, so a press lands where a person's finger would. A frame
 * with no size, or no web address, is left out.
 */

import type { CdpTransport } from "./cdp";
import { MAX_FRAMES, type FrameDoc } from "./frames";

type Send = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
type Point = { x: number; y: number };
type FrameTree = { frame: { id: string; url?: string }; childFrames?: FrameTree[] };

interface Session {
  send: Send;
  /** The frame this session's document is: the page's own, or another site's frame. */
  rootFrameId: string | null;
  /** Null for the page itself, else the target's id (which is its frame's id). */
  targetId: string | null;
}

/** Nested frames deeper than this are not looked into. */
const MAX_DEPTH = 4;

/**
 * A lister of the page's frames, for one connection: the other sites' frames
 * are attached once and remembered, and every call reads where each frame is now.
 */
export function frameLister(cdp: CdpTransport, topSend: Send, mouseClick: (x: number, y: number) => Promise<void>): () => Promise<FrameDoc[]> {
  const attached = new Map<string, Session>();
  const enabled = new Set<string | null>();
  let watching: Promise<void> | null = null;

  function watch(): Promise<void> {
    watching ??= (async () => {
      cdp.on?.("Target.attachedToTarget", (raw) => {
        const params = raw as { sessionId?: unknown; targetInfo?: { targetId?: unknown; type?: unknown } } | null;
        const targetId = params?.targetInfo?.targetId;
        const sessionId = params?.sessionId;
        if (params?.targetInfo?.type !== "iframe" || typeof targetId !== "string" || typeof sessionId !== "string") return;
        if (attached.size >= MAX_FRAMES || attached.has(targetId)) return;
        attached.set(targetId, { send: (method, params) => cdp.send(method, params, sessionId), rootFrameId: targetId, targetId });
      });
      // The page reports every frame from another site it has, and each new one.
      await topSend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
    })();
    return watching;
  }

  return async () => {
    await watch();
    const top: Session = { send: topSend, rootFrameId: null, targetId: null };
    const sessions = [top, ...attached.values()];
    const offsets = new Map<Session, Point | null>([[top, { x: 0, y: 0 }]]);

    /** Where the `<iframe>` holding `frameId` shows, by the session that holds that element. */
    async function ownerBox(frameId: string, depth: number): Promise<Point | null> {
      for (const session of sessions) {
        const owner = await session.send<{ backendNodeId?: number }>("DOM.getFrameOwner", { frameId }).catch(() => null);
        if (typeof owner?.backendNodeId !== "number") continue;
        const box = await session.send<{ model?: { content?: number[]; width?: number; height?: number } }>("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }).catch(() => null);
        const quad = box?.model?.content;
        if (!Array.isArray(quad) || quad.length < 2 || !(Number(box?.model?.width) > 0) || !(Number(box?.model?.height) > 0)) return null;
        const base = await rootOffset(session, depth + 1);
        return base === null ? null : { x: base.x + quad[0]!, y: base.y + quad[1]! };
      }
      return null;
    }

    /** Where a session's own document starts on the screen. */
    async function rootOffset(session: Session, depth: number): Promise<Point | null> {
      if (offsets.has(session)) return offsets.get(session)!;
      if (depth > MAX_DEPTH || session.targetId === null) return null;
      offsets.set(session, null); // a loop answers "nowhere"
      const point = await ownerBox(session.targetId, depth);
      offsets.set(session, point);
      return point;
    }

    const docs: FrameDoc[] = [];
    for (const session of sessions) {
      if (enabled.has(session.targetId)) continue;
      enabled.add(session.targetId);
      await session.send("DOM.enable").catch(() => undefined);
      await session.send("Page.enable").catch(() => undefined);
    }
    for (const session of sessions) {
      if (docs.length >= MAX_FRAMES) break;
      const tree = await session.send<{ frameTree?: FrameTree }>("Page.getFrameTree").catch(() => null);
      const root = tree?.frameTree;
      if (!root) continue;
      // Another site's frame is itself a document; then, in any session, the same-site frames inside.
      const candidates: Array<{ frameId: string; contextId: number | null }> = [];
      if (session.targetId !== null) candidates.push({ frameId: root.frame.id, contextId: null });
      const walk = (node: FrameTree, depth: number) => {
        for (const child of node.childFrames ?? []) {
          candidates.push({ frameId: child.frame.id, contextId: -1 });
          if (depth < MAX_DEPTH) walk(child, depth + 1);
        }
      };
      walk(root, 0);
      for (const candidate of candidates) {
        if (docs.length >= MAX_FRAMES) break;
        // Another site's frame listed in its parent's tree has its own session above; it is skipped here.
        if (candidate.contextId === -1 && attached.has(candidate.frameId)) continue;
        let contextId: number | null = null;
        if (candidate.contextId === -1) {
          const world = await session.send<{ executionContextId?: number }>("Page.createIsolatedWorld", { frameId: candidate.frameId, worldName: "tex" }).catch(() => null);
          if (typeof world?.executionContextId !== "number") continue;
          contextId = world.executionContextId;
        }
        const doc = await frameDoc(session, contextId, () =>
          contextId === null ? rootOffset(session, 0) : ownerBox(candidate.frameId, 0),
        mouseClick, topSend);
        if (doc !== null) docs.push(doc);
      }
    }
    return docs;
  };
}

async function frameDoc(
  session: Session,
  contextId: number | null,
  offset: () => Promise<Point | null>,
  mouseClick: (x: number, y: number) => Promise<void>,
  topSend: Send,
): Promise<FrameDoc | null> {
  async function evaluate<T>(source: string): Promise<T> {
    const result = await session.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression: source,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId === null ? {} : { contextId }),
    });
    if (result.exceptionDetails) throw new Error("the frame threw");
    return result.result?.value as T;
  }
  const host = await evaluate<string>("location.protocol === 'https:' || location.protocol === 'http:' ? location.hostname : ''").catch(() => "");
  if (!host) return null;
  // A frame with no size shows nothing a person could press.
  if ((await offset()) === null) return null;
  return {
    host,
    evaluate,
    async click(selector) {
      const box = await evaluate<Point | null>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      const at = await offset();
      if (!box || !at) throw new Error("no such element");
      await mouseClick(at.x + box.x, at.y + box.y);
    },
    async type(selector, text) {
      const found = await evaluate<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.focus();
        return true;
      })()`);
      if (!found) throw new Error("no such element");
      // Keys go to the frame that has focus; the frame's own session first, the page's if it has no input of its own.
      await session.send("Input.insertText", { text }).catch(() => topSend("Input.insertText", { text }));
    },
  };
}

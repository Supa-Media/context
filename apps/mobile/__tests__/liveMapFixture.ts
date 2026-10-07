/**
 * Shared fixtures for the live map engine's tests: small fake workspaces, a
 * fake 2D context that records what was drawn, and a palette. Fake names only.
 */
import type { ActorRef, MapEvent, WorkspaceGraph } from "../features/console/map/live/types";
import { lightColors, lightMapColors } from "../features/design/tokens/colors";
import { mapPalette } from "../features/console/map/live/engine/palette";

export const palette = mapPalette(lightColors, lightMapColors);

export const WHO: Record<"maya" | "jon" | "claude" | "sorter", ActorRef> = {
  maya: { id: "u:maya", kind: "person", name: "Maya" },
  jon: { id: "u:jon", kind: "person", name: "Jon" },
  claude: { id: "a:claude", kind: "agent", name: "Seyi's Claude" },
  sorter: { id: "a:sorter", kind: "agent", name: "Inbox sorter" },
};

/** A workspace from a list of paths; links chain each folder's notes. */
export function graph(workspaceId: string, name: string, paths: string[], kind: "personal" | "shared" = "personal"): WorkspaceGraph {
  const nodes = paths.map((path) => ({ path, title: (path.split("/").pop() ?? path).replace(/\.md$/, "") }));
  const edges: [number, number][] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const a = nodes[i - 1]!.path.split("/")[0];
    const b = nodes[i]!.path.split("/")[0];
    if (a === b) edges.push([i - 1, i]);
  }
  return { workspaceId, slug: workspaceId, name, kind, nodes, edges };
}

/** A PARA workspace with `per` notes in each root folder and two subfolders in Projects. */
export function para(workspaceId = "ws-a", name = "Personal", per = 12): WorkspaceGraph {
  const paths: string[] = [];
  for (const root of ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"]) {
    for (let i = 0; i < per; i += 1) {
      if (root === "1-projects") paths.push(`${root}/${i % 2 ? "launch" : "pricing"}/note ${root} ${i}.md`);
      else paths.push(`${root}/note ${root} ${i}.md`);
    }
  }
  paths.push("index.md");
  return graph(workspaceId, name, paths);
}

export const ev = {
  read: (at: number, ws: string, path: string, actor: ActorRef = WHO.claude): MapEvent => ({ kind: "read", at, workspaceId: ws, path, actor }),
  edit: (at: number, ws: string, path: string, actor: ActorRef = WHO.maya): MapEvent => ({ kind: "edit", at, workspaceId: ws, path, actor }),
  create: (at: number, ws: string, path: string, actor: ActorRef = WHO.claude): MapEvent => ({ kind: "create", at, workspaceId: ws, path, actor }),
  move: (at: number, ws: string, from: string, to: string, actor: ActorRef = WHO.sorter, toWorkspaceId?: string): MapEvent => ({
    kind: "move",
    at,
    workspaceId: ws,
    from,
    to,
    actor,
    ...(toWorkspaceId ? { toWorkspaceId } : {}),
  }),
};

export type Call = { op: string; args: unknown[]; fillStyle?: unknown; strokeStyle?: unknown; alpha?: number; font?: string };

/**
 * A 2D context that records every call with the style in force. Text is
 * measured at 0.55em per character, which is all the label code needs.
 */
export function fakeContext(): CanvasRenderingContext2D & { calls: Call[] } {
  const calls: Call[] = [];
  const state = {
    fillStyle: "#000" as unknown,
    strokeStyle: "#000" as unknown,
    globalAlpha: 1,
    font: "10px sans-serif",
    lineWidth: 1,
    textAlign: "start",
    textBaseline: "alphabetic",
    lineJoin: "miter",
    lineCap: "butt",
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetY: 0,
  };
  const stack: Array<typeof state> = [];
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, alpha: state.globalAlpha, font: state.font });
  };
  const ctx: Record<string, unknown> = {
    calls,
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop() ?? state),
    measureText: (text: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 10);
      return { width: text.length * size * 0.55 };
    },
    setLineDash: () => {},
  };
  for (const op of ["beginPath", "closePath", "moveTo", "lineTo", "arc", "arcTo", "ellipse", "rect", "clip", "translate", "scale", "setTransform", "clearRect", "drawImage", "strokeRect"]) {
    ctx[op] = record(op);
  }
  for (const op of ["fill", "stroke", "fillText", "strokeText", "fillRect"]) ctx[op] = record(op);
  return new Proxy(ctx, {
    get: (target, key: string) => (key in target ? target[key] : (state as Record<string, unknown>)[key]),
    set: (target, key: string, value) => {
      if (key in state) (state as Record<string, unknown>)[key] = value;
      else target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { calls: Call[] };
}

/** A canvas good enough for `createMapEngine`: a fake context and no DOM. */
export function fakeCanvas(w = 1000, h = 700): HTMLCanvasElement & { ctx: ReturnType<typeof fakeContext> } {
  const ctx = fakeContext();
  const style: Record<string, string> = {};
  return {
    ctx,
    width: w,
    height: h,
    clientWidth: w,
    clientHeight: h,
    style,
    getContext: () => ctx,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
  } as unknown as HTMLCanvasElement & { ctx: ReturnType<typeof fakeContext> };
}

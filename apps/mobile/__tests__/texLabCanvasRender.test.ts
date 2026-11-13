/**
 * The Tex Architecture Lab's canvas drawing (`features/tex/lab/views/canvas/render.ts`) against the artifact it was
 * ported from. `fixtures/texLabCanvasGolden.json` is what the artifact's own page drew for each viewport (desktop and
 * phone) on the core/q1 moment: the world's markup, the stats, the key, every wire's path, the camera after fit, and
 * the focus view of the front door. The port must give the same strings and numbers.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

// The artifact's own graph: main's is corrected to the code (`texLabMainGraph.test.ts`), the port is held to the artifact.
jest.mock("../features/tex/lab/data/graph", () => jest.requireActual<typeof import("./fixtures/texLabArtifactGraph")>("./fixtures/texLabArtifactGraph").artifactGraphModule());
import golden from "./fixtures/texLabCanvasGolden.json";
import { allCases } from "../features/tex/lab/engine/diff";
import { simulate } from "../features/tex/lab/engine/sim";
import { G, lab, node } from "../features/tex/lab/engine/state";
import { buildTraces, SCENARIOS } from "../features/tex/lab/engine/traces";
import {
  fbarHtml,
  fitCam,
  keywHtml,
  renderFocusCanvasHtml,
  renderGraphHtml,
  statsHtml,
  wirePath,
  zoomCam,
  wheelCam,
  addStepNode,
  W,
  H,
} from "../features/tex/lab/views/canvas/render";

type Viewport = {
  rect: { w: number; h: number };
  cam: { x: number; y: number; k: number };
  scn: string;
  world: string;
  stats: string;
  keyw: string;
  paths: Array<{
    from: string;
    to: string;
    mode: string;
    p: { d: string; lx?: number; ly?: number };
  }>;
  focusCam: { x: number; y: number; k: number };
  focusWorld: string;
  fbar: string;
  fBounds: { x0: number; x1: number; y0: number; y1: number };
};
const GOLDEN = golden as unknown as Record<"desktop" | "phone", Viewport>;

const FOCUS_STAGE = {
  desktop: { width: 758, height: 943 },
  phone: { width: 389, height: 289.3 },
};

const rectOf = (v: Viewport) => ({ width: v.rect.w, height: v.rect.h });

/** Shows the first differing stretch, so a mismatch is readable without dumping 30 KB. */
function firstDiff(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `first difference at ${i}:\n  port:   ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 160))}\n  artifact: ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 160))}`;
}

/**
 * What the browser keeps once the artifact's string is set as innerHTML inside the SVG: a self-closing foreign element
 * `<x .../>` is closed as `<x ...></x>`, and attributes are written with one space between them. The golden holds that
 * serialization, so the port's string goes through the same step before it is compared.
 */
const normAttrs = (a: string) =>
  [...a.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)]
    .map((m) => (m[2] === undefined ? ` ${m[1]}` : ` ${m[1]}="${m[2]}"`))
    .join("");
const domSerialize = (html: string) =>
  html
    .replace(
      /<([A-Za-z][\w-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/>/g,
      (_, tag: string, attrs: string) => `<${tag}${normAttrs(attrs)}></${tag}>`,
    )
    .replace(
      /<([A-Za-z][\w-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*>/g,
      (_, tag: string, attrs: string) => `<${tag}${normAttrs(attrs)}>`,
    );

/** Puts the Lab in the state the artifact was captured in: core/q1 traced, no focus, no selection. */
function setupScn(scn: string) {
  buildTraces(allCases());
  lab.scn = scn;
  lab.cfocus = null;
  lab.sel = null;
}

afterEach(() => {
  lab.cfocus = null;
  lab.sel = null;
});

for (const vp of ["desktop", "phone"] as const) {
  describe(`canvas render, ${vp}`, () => {
    const v = GOLDEN[vp];

    test("the world markup is the artifact's, byte for byte", () => {
      setupScn(v.scn);
      const sim = simulate(G(), lab.scn, null);
      const html = domSerialize(
        renderGraphHtml(G(), sim, SCENARIOS[lab.scn].tags, null, null),
      );
      if (html !== v.world) throw new Error(firstDiff(html, v.world));
      expect(html).toBe(v.world);
    });

    test("the stats line and the wire key are the artifact's", () => {
      setupScn(v.scn);
      const sim = simulate(G(), lab.scn, null);
      expect(statsHtml(sim)).toBe(v.stats);
      expect(domSerialize(keywHtml())).toBe(v.keyw);
    });

    test("every wire path is the artifact's", () => {
      setupScn(v.scn);
      for (const p of v.paths) {
        const a = node(p.from)!;
        const b = node(p.to)!;
        expect(wirePath(a, b, p.mode)).toEqual(p.p);
      }
    });

    test("the whole-graph camera after fit is the artifact's", () => {
      setupScn(v.scn);
      const cam = fitCam(G().nodes, rectOf(v), null)!;
      expect(cam.x).toBeCloseTo(v.cam.x, 6);
      expect(cam.y).toBeCloseTo(v.cam.y, 6);
      expect(cam.k).toBeCloseTo(v.cam.k, 6);
    });

    test("the focus view on the front door is the artifact's", () => {
      setupScn(v.scn);
      lab.cfocus = "fd";
      lab.sel = { t: "node", id: "fd" };
      const sim = simulate(G(), lab.scn, null);
      const focus = renderFocusCanvasHtml(G(), sim, "fd", lab.sel);
      const html = domSerialize(focus.html);
      const fBounds = focus.fBounds;
      if (html !== v.focusWorld) throw new Error(firstDiff(html, v.focusWorld));
      expect(html).toBe(v.focusWorld);
      expect(fBounds).toEqual(v.fBounds);
      // The golden records the viewport, not the stage the focus was fitted into. The stage sizes below are the ones
      // that reproduce the golden focus camera exactly under the artifact's fit (desktop: k = 758 / 1170; phone: the
      // 0.3 floor with a 289.3 px stage). They are inferred from the golden, not measured.
      const cam = fitCam(G().nodes, FOCUS_STAGE[vp], fBounds)!;
      expect(cam.x).toBeCloseTo(v.focusCam.x, 6);
      expect(cam.y).toBeCloseTo(v.focusCam.y, 6);
      expect(cam.k).toBeCloseTo(v.focusCam.k, 6);
      expect(fbarHtml("Front door")).toBe(v.fbar);
    });
  });
}

describe("camera and step helpers", () => {
  test("zoom clamps the scale to [0.2, 2]", () => {
    const rect = { width: 800, height: 600 };
    expect(zoomCam({ x: 0, y: 0, k: 1 }, 100, rect).k).toBe(2);
    expect(zoomCam({ x: 0, y: 0, k: 1 }, 0.001, rect).k).toBe(0.2);
  });

  test("zoom keeps the stage centre still", () => {
    const rect = { width: 800, height: 600 };
    const cam = { x: 10, y: -20, k: 1 };
    const z = zoomCam(cam, 2, rect);
    const cx = (rect.width / 2 - cam.x) / cam.k;
    const cy = (rect.height / 2 - cam.y) / cam.k;
    expect((rect.width / 2 - z.x) / z.k).toBeCloseTo(cx, 9);
    expect((rect.height / 2 - z.y) / z.k).toBeCloseTo(cy, 9);
  });

  test("the wheel pans without ctrl and zooms with it", () => {
    const cam = { x: 5, y: 7, k: 1 };
    expect(
      wheelCam(
        cam,
        {
          deltaX: 3,
          deltaY: 4,
          ctrlKey: false,
          metaKey: false,
          clientX: 0,
          clientY: 0,
        },
        { left: 0, top: 0 },
      ),
    ).toEqual({ x: 2, y: 3, k: 1 });
    const z = wheelCam(
      cam,
      {
        deltaX: 0,
        deltaY: -50,
        ctrlKey: true,
        metaKey: false,
        clientX: 50,
        clientY: 60,
      },
      { left: 10, top: 10 },
    );
    expect(z.k).toBeCloseTo(Math.exp(0.5), 9);
  });

  test("addStep picks step1, then step2 when step1 exists, with positions snapped to 10", () => {
    const rect = { width: 803, height: 517 };
    const cam = { x: 33, y: 41, k: 0.7 };
    const a = addStepNode("haiku-5-5", cam, rect, () => false);
    expect(a.id).toBe("step1");
    expect(a.label).toBe("New step 1");
    expect(a.opts.x % 10).toBe(0);
    expect(a.opts.y % 10).toBe(0);
    expect(a.opts.model).toBe("haiku-5-5");
    const b = addStepNode("code", cam, rect, (id) => id === "step1");
    expect(b.id).toBe("step2");
    expect(b.opts.model).toBe("code");
    expect(b.opts.ms).toBe(200);
    expect(b.opts.x % 10).toBe(0);
    expect(b.opts.y % 10).toBe(0);
    // the centre of the stage, in graph coordinates, minus half a card, snapped
    expect(b.opts.x).toBe(
      Math.round(((rect.width / 2 - cam.x) / cam.k - W / 2) / 10) * 10,
    );
    expect(b.opts.y).toBe(
      Math.round(((rect.height / 2 - cam.y) / cam.k - H / 2) / 10) * 10,
    );
  });
});

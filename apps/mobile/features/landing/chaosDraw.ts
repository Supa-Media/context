import { caps, cursor, icon, line, pill, SANS, type Ink } from "./chaosIcons";
import {
  ENTER,
  FADE,
  FLY,
  folderIndex as F,
  HELPERS,
  HG,
  lastStop,
  MOVE,
  ROLE_NAME,
  ROLES,
  SHOW,
  WORKSPACES,
  type Founder,
  type Note,
  type Story,
} from "./chaosStory";

/**
 * Page a's graph, drawn on a canvas at time `t` of `chaosStory`. Personal has
 * the whole width until the first co-founder joins; then it slides over and
 * Hangg takes the right half (Dev, 2026-10-11: "don't split the graph until we
 * are ready to make the hangg workspace", side by side on every screen). Each
 * workspace is a faint dotted outline with a hub tied to its five folders.
 * Loose notes are icons, filed ones dots; Archive swallows what goes in. The
 * helpers are cursors (Sayo: "cursors look a lot better").
 *
 * `draw` returns how unsettled things are, which Tex at the top follows.
 */

/** Where each folder sits round its workspace's hub, in degrees. */
const ANGLE: Record<(typeof ROLES)[number], number> = { inbox: -155, projects: -90, areas: -25, archive: 35, resources: 145 };
/** How far apart filed notes sit. */
const GAP = 3;
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

type At = [x: number, y: number, first: number, cur: number, folder: number];

export function chaosScene(story: Story) {
  const { folders, nodes, movers, late, founders, jobs, tangle, links } = story;
  let W = 0;
  let H = 0;
  let split = 0;
  const roam: ([number, number] | null)[] = HELPERS.map(() => null);

  // Personal has the whole width until Hangg is made; then it slides over to share it.
  const box = (ws: number): [number, number, number, number] =>
    ws ? [(0.51 + 0.3 * (1 - split)) * W, 0, 0.49 * W, H] : [0, 0, (1 - 0.51 * split) * W, H];
  const wsHub = (ws: number): [number, number] => {
    const [x, y, w, h] = box(ws);
    return [x + w / 2, y + h * 0.56];
  };
  const hub = (fi: number): [number, number] => {
    const f = folders[fi]!;
    const [, , w, h] = box(f.ws);
    const [cx, cy] = wsHub(f.ws);
    const a = (ANGLE[f.role] * Math.PI) / 180;
    return [cx + Math.cos(a) * 0.36 * w, cy + Math.sin(a) * 0.3 * h];
  };
  const radius = (fi: number) => 5 + GAP * Math.sqrt(folders[fi]!.n);
  // Sunflower slots round the folder; Archive keeps everything at its box.
  const spot = (fi: number, k: number): [number, number] => {
    const [hx, hy] = hub(fi);
    if (folders[fi]!.role === "archive") return [hx, hy];
    const a = k * 2.39996;
    const r = 5 + GAP * Math.sqrt(k + 1);
    return [hx + Math.cos(a) * r, hy + Math.sin(a) * r];
  };
  const founderAt = (f: Founder, t: number): [number, number, number] => {
    const [hx, hy] = wsHub(HG);
    const to = [hx - 42, hy + f.dy];
    const from = [f.from[0] * W, f.from[1] * H];
    const q = ease((t - f.at) / ENTER);
    return [from[0]! + (to[0]! - from[0]!) * q, from[1]! + (to[1]! - from[1]!) * q, q];
  };
  // The app's name grows up: "New app", then "Friend hangout app" in Personal, then Hangg once it moves out.
  let appHere = 0;
  let appGone = false;
  const projectName = (ws: number) => (ws ? "Beta" : appGone ? "Half marathon" : appHere < 6 ? "New app" : "Friend hangout app");
  const folderName = (fi: number) => {
    const f = folders[fi]!;
    return (f.ws ? "Hangg " : "") + (f.role === "projects" ? projectName(f.ws) : ROLE_NAME[f.role]);
  };

  /** Where a note is at t, how far into its first stop and its current one, and which folder it is in. */
  function pos(n: Note, t: number): At {
    let x: number;
    let y: number;
    const mine = n.founder === undefined ? null : founders[n.founder]!;
    if (mine) {
      const [fx, fy] = founderAt(mine, n.arrive);
      x = fx + n.near![0] * W;
      y = fy + n.near![1] * H;
    } else {
      x = n.lx * W;
      y = n.ly * H;
    }
    const fly = ease((t - n.arrive) / FLY);
    const sx = mine ? founderAt(mine, n.arrive) : [n.ex * W, n.ey * H];
    x = sx[0]! + (x - sx[0]!) * fly;
    y = sx[1]! + (y - sx[1]!) * fly;
    let first = 0;
    let cur = 0;
    let folder = -1;
    n.stops.forEach((s, i) => {
      const p = ease((t - s.t) / MOVE);
      if (p <= 0) return;
      const [tx, ty] = spot(s.folder, s.k!);
      x += (tx - x) * p;
      y += (ty - y) * p;
      cur = p;
      folder = s.folder;
      if (i === 0) first = p;
    });
    return [x, y, first, cur, folder];
  }

  function draw(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, c: Ink): number {
    W = width;
    H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = t > story.hold - FADE ? Math.max(0, (story.hold - t) / FADE) : 1;
    split = ease((t - founders[0]!.at - 200) / 1000);
    const P = new Map(nodes.map((n) => [n, pos(n, t)]));
    const at = (n: Note) => P.get(n)!;
    const final = (n: Note) => lastStop(n).folder;
    const seen = (n: Note) => ease((t - n.arrive - FLY * 0.8) / 300); // the tangle ties on as a note lands
    const shown = (n: Note) => ease((t - n.arrive) / 150);
    const wsShown = [ease((t - 900) / 700), ease((t - story.form) / 700) * split];
    appHere = movers.filter((n) => at(n)[4] === F(0, "projects") && at(n)[3] > 0.5).length;
    appGone = t > story.shift + (story.shiftEnd - story.shift) / 2;

    // The workspaces: a faint dotted outline each, so they read as separate without boxing anything in.
    WORKSPACES.forEach((name, ws) => {
      const s = wsShown[ws]!;
      if (s <= 0) return;
      const [x, y, bw, bh] = box(ws);
      const [cx, cy] = wsHub(ws);
      ctx.save();
      ctx.globalAlpha *= s;
      ctx.strokeStyle = c.hair;
      ctx.lineWidth = 1.2;
      ctx.lineCap = "round";
      ctx.setLineDash([0.5, 5]);
      ctx.beginPath();
      ctx.roundRect(x + 3, y + 3, bw - 6, bh - 6, 16);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.ink2;
      ctx.font = "italic 13px Libron, Georgia, serif";
      ctx.textAlign = "left";
      ctx.fillText(W < 560 ? ["Personal", "Hangg · shared"][ws]! : name, x + 12, y + 19); // short names on a phone
      ROLES.forEach((role) => line(ctx, [cx, cy], hub(F(ws, role)), 0.45, c.ink2, 1));
      ctx.fillStyle = c.ink;
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, 7);
      ctx.fill();
      ctx.restore();
    });
    // The tangle, fading from each end as its notes are filed.
    tangle.forEach(([a, b]) =>
      line(ctx, at(a), at(b), Math.min(seen(a), seen(b)) * (1 - at(a)[2]) * (1 - at(b)[2]) * 0.35, c.ink2, 0.7),
    );
    // Links between notes, once both ends are where they end up.
    links.forEach(([a, b]) => {
      const pa = at(a);
      const pb = at(b);
      if (pa[4] !== final(a) || pb[4] !== final(b)) return;
      line(ctx, pa, pb, Math.pow(pa[3] * pb[3], 2) * (final(a) === final(b) ? 0.3 : 0.14), c.ink2, 0.6);
    });
    // The co-founders, and the notes they bring.
    founders.forEach((f, i) => {
      if (t < f.at) return;
      const fa = founderAt(f, t);
      late.filter((n) => n.founder === i).forEach((n) => line(ctx, fa, at(n), seen(n) * (1 - at(n)[2]) * 0.4, c.ink2, 0.7));
      line(ctx, fa, wsHub(HG), fa[2] * 0.5, c.ink2, 1);
    });
    // Each note tied to the folder it is in (Archive swallows its notes), then the folders.
    nodes.forEach((n) => {
      const p = at(n);
      if (p[4] >= 0 && folders[p[4]]!.role !== "archive") line(ctx, hub(p[4]), p, 0.4 * p[3], c.ink2, 0.8);
    });
    folders.forEach((f, fi) => {
      const s = wsShown[f.ws]!;
      if (s <= 0) return;
      const [hx, hy] = hub(fi);
      ctx.save();
      ctx.globalAlpha *= s;
      if (f.role === "archive") {
        // A box, not a cluster: what goes in stays out of the way.
        ctx.fillStyle = c.card;
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(hx - 10, hy - 6, 20, 14, 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.roundRect(hx - 12, hy - 10, 24, 5, 1.5);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(hx - 3, hy - 1);
        ctx.lineTo(hx + 3, hy - 1);
        ctx.stroke();
      } else {
        ctx.fillStyle = c.ink;
        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, 0, 7);
        ctx.fill();
      }
      // The folder's name sits under it, haloed so links never cut through it. Projects also names the project.
      const r = f.role === "archive" ? 12 : f.role === "inbox" ? 5 + GAP * Math.sqrt(5) : radius(fi);
      let ly = hy + r + 12;
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      ctx.strokeStyle = c.paper;
      ctx.lineWidth = 4;
      ctx.font = `600 9.5px ${SANS}`;
      ctx.fillStyle = c.ink2;
      const txt = caps(ROLE_NAME[f.role]);
      ctx.strokeText(txt, hx, ly);
      ctx.fillText(txt, hx, ly);
      if (f.role === "projects") {
        ly += 13;
        ctx.font = `600 12px ${SANS}`;
        ctx.fillStyle = c.ink;
        const name = projectName(f.ws);
        ctx.strokeText(name, hx, ly);
        ctx.fillText(name, hx, ly);
      }
      ctx.restore();
    });

    // Where each helper is: on a named note it reads then carries it; otherwise it roams to whatever it is filing.
    const helpers = HELPERS.map((name, b) => {
      const mine = b >= 2 ? founders[b - 2]! : null;
      if (mine && t < mine.at + ENTER * 0.7) {
        roam[b] = null; // a co-founder's assistant starts when they join
        return null;
      }
      const [px, py] = mine ? founderAt(mine, t) : wsHub(0);
      // Idle, Claude and ChatGPT wait in Personal; a co-founder's assistant waits by them.
      const home: [number, number] = mine ? [px + 14, py + 26] : [px + (b ? 30 : -70), py + 34];
      const job = jobs.find((j) => j.helper === b && t >= j.t - SHOW && t <= j.t + MOVE);
      const busy: Note[] = [];
      const busyAt: number[] = [];
      nodes.forEach((n) =>
        n.stops.forEach((st) => {
          if (st.helper === b && t >= st.t && t <= st.t + MOVE) {
            busy.push(n);
            busyAt.push(st.t);
          }
        }),
      );
      let target: readonly number[] = home;
      if (job) target = at(job.n);
      else if (busy.length) target = busy.reduce((a, n) => [a[0] + at(n)[0] / busy.length, a[1] + at(n)[1] / busy.length], [0, 0]);
      const r = roam[b] ?? (roam[b] = [home[0], home[1]]);
      const k = job ? 0.35 : 0.08;
      r[0] += (target[0]! - r[0]) * k;
      r[1] += (target[1]! - r[1]) * k;
      if (job && t > job.t - SHOW + 250) {
        r[0] = target[0]!;
        r[1] = target[1]!;
      }
      return { name, at: r, job, busy, busyAt, color: c.agents[b]! };
    }).filter((h) => h !== null);

    // Each note in motion glows in the colour of the helper moving it.
    helpers.forEach((h) =>
      h.busy.forEach((n, i) => {
        const q = (t - h.busyAt[i]!) / MOVE;
        const [x, y] = at(n);
        ctx.save();
        ctx.globalAlpha *= 0.35 * Math.sin(Math.PI * q);
        ctx.fillStyle = h.color;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, 7);
        ctx.fill();
        ctx.restore();
      }),
    );
    // A drop ring where each note lands.
    nodes.forEach((n) =>
      n.stops.forEach((st) => {
        const q = (t - st.t - MOVE) / 450;
        if (q < 0 || q > 1) return;
        const [x, y] = spot(st.folder, st.k!);
        ctx.save();
        ctx.globalAlpha *= 0.6 * (1 - q);
        ctx.strokeStyle = c.agents[st.helper!]!;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, 3 + q * 9, 0, 7);
        ctx.stroke();
        ctx.restore();
      }),
    );
    // On a named note: a ring while the helper reads it, then a dashed route to where it goes.
    helpers.forEach((h) => {
      const j = h.job;
      if (!j) return;
      const [x, y] = at(j.n);
      const st = j.n.stops[j.stop]!;
      const dest = spot(st.folder, st.k!);
      ctx.save();
      ctx.strokeStyle = h.color;
      ctx.lineWidth = 1.6;
      if (t < j.t) {
        const a = t / 260;
        ctx.beginPath();
        ctx.arc(x, y, 9, a, a + 4.2);
        ctx.stroke();
      }
      ctx.setLineDash([3, 4]);
      ctx.globalAlpha *= 0.7;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(dest[0], dest[1]);
      ctx.stroke();
      ctx.restore();
    });
    // The notes. Loose, a note is what it came in as; filed, it is a dot; archived, it disappears into the box.
    const carried = new Set(jobs.filter((j) => t > j.t - SHOW && t < j.t + MOVE).map((j) => j.n));
    nodes.forEach((n) => {
      let s = shown(n);
      if (s <= 0) return;
      const p = at(n);
      const asIcon = 1 - Math.min(1, p[2] * 2);
      if (p[4] >= 0 && folders[p[4]]!.role === "archive") s *= 1 - p[3];
      if (s <= 0.01) return;
      if (asIcon > 0) {
        ctx.save();
        ctx.globalAlpha *= s * asIcon;
        icon(ctx, n.icon, p[0], p[1], t + n.arrive * 7, c);
        ctx.restore();
      }
      if (asIcon < 1) {
        ctx.save();
        ctx.globalAlpha *= s * (1 - asIcon);
        ctx.fillStyle = c.ink;
        ctx.beginPath();
        ctx.arc(p[0], p[1], carried.has(n) ? 4.5 : 2.4, 0, 7);
        ctx.fill();
        ctx.restore();
      }
    });
    // The co-founders themselves: a ring with an initial, named as they join.
    founders.forEach((f) => {
      if (t < f.at) return;
      const [x, y] = founderAt(f, t);
      ctx.save();
      ctx.fillStyle = c.card;
      ctx.strokeStyle = c.blue;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.blue;
      ctx.font = `700 11px ${SANS}`;
      ctx.textAlign = "center";
      ctx.fillText(f.name[0]!, x, y + 4);
      ctx.restore();
      if (t < f.at + ENTER + 800) pill(ctx, W, x, y - 2, "Co-founder", f.name + " joined", c);
      else {
        ctx.save();
        ctx.fillStyle = c.ink;
        ctx.font = `600 11px ${SANS}`;
        ctx.textAlign = "right";
        ctx.lineWidth = 4;
        ctx.strokeStyle = c.paper;
        ctx.lineJoin = "round";
        ctx.strokeText(f.name, x - 16, y + 4);
        ctx.fillText(f.name, x - 16, y + 4);
        ctx.restore();
      }
    });
    // The helpers: a cursor each, with a name flag saying what they are doing.
    helpers.forEach((h) => {
      const [hx, hy] = h.at;
      const j = h.job;
      if (j) pill(ctx, W, hx, hy, j.kind, j.label, c);
      const doing = j ? (t < j.t ? "reading" : "filing to " + folderName(j.n.stops[j.stop]!.folder)) : h.busy.length ? "sorting" : "";
      cursor(ctx, W, hx, hy, h.name, doing, h.color, c);
    });
    ctx.globalAlpha = 1;
    // How unsettled things are: notes that have landed but are not yet where they are going.
    const unsettled = nodes.filter((n) => t >= n.arrive && (at(n)[4] < 0 || at(n)[3] < 1)).length;
    return (unsettled / 14) * (t > story.form ? 0.7 : 1);
  }

  return { draw };
}

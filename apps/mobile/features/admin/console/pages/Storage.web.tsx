/**
 * Storage: the artifact's `P.storage`. Two panels: where each workspace's notes are read and written
 * (its object, copying to it, or still on the bucket) and the backup encryption rollout. Workspaces
 * move one step at a time through `adminStorage.moveWorkspaceHome`; the encryption panel is
 * `managedEncryption`'s rollout, the same one the Estate card reads.
 */
import { useMutation, useQueries } from "convex/react";
import { useMemo } from "react";
import { api } from "@context/convex/_generated/api";
import { LOAD_FAILED, failureLine, type RolloutStatus } from "../../encryption";
import { confirmBox, esc, kpi, legend, panel, pill } from "../kit";
import { S, render, setF, toast } from "../state";
import type { ConsolePage } from "../types";

type Home = "bucket" | "dual" | "object";
type LastMove = { to: "dual" | "object"; state: "started" | "done" | "refused" | "failed"; reason: string | null; at: number } | null;
type StorageWorkspace = { workspaceId: string; slug: string; kind: "personal" | "shared"; home: Home; notes: number | null; since: number | null; lastMove?: LastMove };
type StorageReport = { counts: { object: number; dual: number; bucket: number; total: number }; workspaces: StorageWorkspace[] };
type Loaded<T> = T | Error | undefined;

export type StorageData = {
  report: Loaded<StorageReport>;
  rollout: Loaded<RolloutStatus>;
  moveHome: (a: { workspaceId: string; to: "dual" | "object" }) => Promise<unknown>;
  retry: (a: { workspaceId: string }) => Promise<unknown>;
  pause: (a: { reason: string }) => Promise<unknown>;
  resume: (a: Record<string, never>) => Promise<unknown>;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const count = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);
const shortDay = (at: number) => {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const HOME_TONE: Record<Home, string> = { object: "ok", dual: "acc", bucket: "" };
/** A thrown error's words for a toast: the server's message when it has one, short. */
const errorWords = (e: unknown) => {
  const data = (e as { data?: { message?: unknown } })?.data;
  const message = typeof data?.message === "string" ? data.message : (e as { message?: unknown })?.message;
  return typeof message === "string" && message.length > 0 ? message.slice(0, 160) : "That didn't work. Try again.";
};
const ok = <T,>(v: Loaded<T>): T | undefined => (v instanceof Error ? undefined : v);

function useStorageData(): StorageData {
  const specs = useMemo(
    () => ({
      report: { query: api.functions.adminStorage.storageReport, args: {} },
      rollout: { query: api.functions.managedEncryption.rolloutStatus, args: {} },
    }),
    [],
  );
  const got = useQueries(specs);
  return {
    report: got.report as Loaded<StorageReport>,
    rollout: got.rollout as Loaded<RolloutStatus>,
    moveHome: useMutation(api.functions.adminStorage.moveWorkspaceHome) as unknown as StorageData["moveHome"],
    retry: useMutation(api.functions.managedEncryption.retryWorkspace) as unknown as StorageData["retry"],
    pause: useMutation(api.functions.managedEncryption.pauseRollout) as StorageData["pause"],
    resume: useMutation(api.functions.managedEncryption.resumeRollout) as StorageData["resume"],
  };
}

/** Why the last move of a workspace did not go through, in words, under its button. */
const REFUSED: Record<string, string> = {
  NOT_BACKFILLED: "not copied yet",
  PARITY_STALE: "the parity check is stale",
  PARITY_DIFFERS: "its object and bucket differ",
  OBJECT_UNREACHABLE: "its object did not answer",
};
function refusedLine(move: LastMove) {
  if (move === null || (move.state !== "refused" && move.state !== "failed")) return "";
  const why = move.state === "failed" ? "the move failed" : (REFUSED[move.reason ?? ""] ?? move.reason ?? "refused");
  return `<div class="sub" style="color:var(--warn);font-size:12.5px">Last try: ${esc(why)}</div>`;
}

const LOADING = '<div class="empty">Loading…</div>';

/** The encryption panel's pill: the rollout's state, in the artifact's words. */
function rolloutPill(r: RolloutStatus) {
  switch (r.state) {
    case "running":
      return pill("Running", "acc");
    case "paused":
      return pill("Paused", "warn");
    case "complete":
      return pill("Complete", "ok");
    case "failed":
      return pill("Failed check", "bad");
    default:
      return pill("Off");
  }
}

function movingPanel(d: StorageData | undefined) {
  const report = ok(d?.report);
  const list = report ? report.workspaces.filter((w) => S.f.ws === "all" || w.home === S.f.ws) : [];
  const total = report?.counts.total ?? 0;
  const body = report
    ? `<div class="share" style="margin-bottom:6px"><i style="width:${pct(report.counts.object, total)}%;background:var(--ok)"></i><i style="width:${pct(report.counts.dual, total)}%;background:var(--c1)"></i><i style="width:${pct(report.counts.bucket, total)}%;background:var(--c6)"></i></div><div class="tbl"><table><tr><th>Workspace</th><th class="hp">Kind</th><th>Home</th><th class="r hp">Notes</th><th class="hp">Switched</th><th></th></tr>${list
        .map((w) => {
          const id = esc(w.workspaceId);
          const move = w.lastMove ?? null;
          const action =
            w.home === "object"
              ? ""
              : move?.state === "started"
                ? `<span class="sub">${move.to === "dual" ? "Copying…" : "Switching…"}</span>`
                : S.confirm === "mv" + w.workspaceId
                ? confirmBox(
                    w.home === "dual" ? `Point @${esc(w.slug)}'s reads at its object?` : `Start copying @${esc(w.slug)} into its object? Reads stay on the bucket.`,
                    w.home === "dual" ? "Switch reads" : "Start",
                    "move",
                    w.workspaceId,
                  )
                : `<button class="ghost" data-act="askmove" data-id="${id}">${w.home === "dual" ? "Switch reads" : "Start moving"}</button>${refusedLine(move)}`;
          return `<tr><td>@${esc(w.slug)}</td><td class="hp">${esc(w.kind)}</td><td>${pill(w.home, HOME_TONE[w.home])}</td><td class="r hp">${w.notes == null ? "—" : count(w.notes)}</td><td class="hp">${w.since == null ? "—" : shortDay(w.since)}</td><td class="r">${action}</td></tr>`;
        })
        .join("")}</table></div>`
    : d?.report instanceof Error
      ? '<div class="empty">Couldn\'t load the workspaces.</div>'
      : LOADING;
  return panel(
    "ws-move",
    "Moving to workspace objects",
    report ? `${count(report.counts.object)} of ${count(total)} done` : "",
    body,
    report && S.f.ws !== "all" ? `<button class="link" data-act="wsf" data-v="all">Show all</button>` : "",
  );
}

function encryptionPanel(d: StorageData | undefined) {
  const r = ok(d?.rollout);
  if (!r) return panel("ws-enc", "Backup encryption", "", d?.rollout instanceof Error ? `<div class="empty">${esc(LOAD_FAILED)}</div>` : LOADING);
  const c = r.counts;
  const active = c.encrypting + c.checking;
  const items: Array<[string, string]> = [
    ["ok", `Encrypted ${count(c.encrypted)}`],
    ["c1", `Encrypting ${count(active)}`],
    ["c6", `Waiting ${count(c.waiting)}`],
    ["bad", `Needs attention ${count(c.failed)}`],
  ];
  const sum = c.encrypted + active + c.waiting + c.failed || 1;
  const bar = `<div class="share"><i style="width:${pct(c.encrypted, sum)}%;background:var(--ok)"></i><i style="width:${pct(active, sum)}%;background:var(--c1)"></i><i style="width:${pct(c.waiting, sum)}%;background:var(--c6)"></i><i style="width:${pct(c.failed, sum)}%;background:var(--bad)"></i></div>`;
  const facts = `<div class="facts"><div><div class="l">Files done</div><div class="v">${count(r.files.done)} of ${count(r.files.total)}</div></div></div>`;
  const failed = r.workspaces
    .filter((w) => w.state === "failed")
    .map(
      (w) =>
        `<div class="row" style="margin-top:10px;padding:8px;border-radius:8px;background:var(--bad-wash)"><span style="flex:1">@${esc(w.slug)}: ${esc(failureLine(w.errorCode))}</span><button class="ghost" data-act="retry" data-id="${esc(w.workspaceId)}">Retry</button></div>`,
    )
    .join("");
  const paused = r.state === "paused";
  const running = r.state === "running";
  const control = S.confirm === "pause" && running
    ? `<input class="search" id="why" placeholder="Why pause?" style="max-width:180px">${confirmBox("New saves go to backup unsealed.", "Pause", "pause", "")}`
    : running
      ? `<button class="ghost" data-act="askpause">Pause</button>`
      : paused
        ? `<button class="ghost" data-act="resume">Resume</button>`
        : "";
  return panel("ws-enc", "Backup encryption", rolloutPill(r), `${bar}${legend("enc", items)}${facts}${failed}`, control);
}

const storage: ConsolePage<StorageData> = {
  key: "storage",
  filters: { ws: "all" },
  windowed: false,
  useData: useStorageData,
  render: (d) => {
    const report = ok(d?.report);
    const c = report?.counts;
    const kp = (v: "object" | "dual" | "bucket", l: string, note: string) =>
      kpi(l, c ? count(c[v]) : "…", note, `data-act="wsf" data-v="${v}" aria-pressed="${S.f.ws === v}"`);
    return `<div class="kpis">${kp("object", "object", "reads and writes there")}${kp("dual", "dual", "copying, reads from the bucket")}${kp("bucket", "bucket", "not started")}</div>${movingPanel(d)}${encryptionPanel(d)}`;
  },
  acts: {
    wsf(e) {
      setF("ws", S.f.ws === e.dataset.v ? "all" : e.dataset.v!);
    },
    askmove(e) {
      S.confirm = "mv" + e.dataset.id;
      render();
    },
    async move(e, d) {
      const row = ok(d?.report)?.workspaces.find((w) => w.workspaceId === e.dataset.id);
      if (!d || !row) return;
      const to = row.home === "bucket" ? "dual" : "object";
      try {
        await d.moveHome({ workspaceId: row.workspaceId, to });
        S.confirm = null;
        toast(to === "dual" ? `@${row.slug} is copying to its object; reads stay on the bucket` : `Switching @${row.slug}'s reads to its object`);
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
    async retry(e, d) {
      const id = e.dataset.id;
      if (!d || !id) return;
      const slug = ok(d.rollout)?.workspaces.find((w) => w.workspaceId === id)?.slug ?? id;
      try {
        await d.retry({ workspaceId: id });
        toast(`Retrying @${slug}`);
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
    askpause(e) {
      S.confirm = "pause";
      render();
      setTimeout(() => (e.closest(".sc")?.querySelector("#why") as HTMLInputElement | null)?.focus(), 0);
    },
    async pause(e, d) {
      const why = (e.closest(".sc")?.querySelector("#why") as HTMLInputElement | null)?.value.trim() ?? "";
      if (!why) return toast("Say why, in one line");
      if (!d) return;
      try {
        await d.pause({ reason: why });
        S.confirm = null;
        toast("Encryption paused");
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
    async resume(_e, d) {
      if (!d) return;
      try {
        await d.resume({});
        toast("Encryption resumed");
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
  },
};

/** Typed as `ConsolePage<StorageData>` above; the registry holds every page as `ConsolePage` (see `types.ts`). */
export const storagePage = storage as ConsolePage;

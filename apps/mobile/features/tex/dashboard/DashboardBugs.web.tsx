/**
 * The bug desk on tex.lc/admin (asked for by the owner, 2026-10-24: "a place
 * where you can track number of bugs filed, and view them/read them and send
 * them to triaging agent to fix", and "add comment for the triaging agent to
 * add more detail, or simply retire a request"). Reports filed by texting Tex
 * are listed from the tree rows; one opens in the reading pane, where a
 * comment, a send to triage, a retire or a reopen is note mail to the triage
 * agent written into the report itself (`api.functions.texDashboard`).
 *
 * The pane shows a report's text as text, never rendered: it holds what
 * people texted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Card } from "./DashboardPanels.web";
import { BUG_STATUSES, bugStatusOf, bugsByDay, shortDate, type BugRow } from "./insights";

type Status = (typeof BUG_STATUSES)[number];
const STATUS_LABELS: Record<Status, string> = { open: "Open", triage: "With triage", fixing: "Being fixed", fixed: "Fixed", retired: "Retired" };

export function BugsPanel({ bugs, days, statusOf, onOpen }: { bugs: readonly BugRow[]; days: readonly string[]; statusOf: (bug: BugRow) => string; onOpen: (path: string) => void }) {
  const [show, setShow] = useState<"waiting" | Status | "all">("waiting");
  const [from, setFrom] = useState<"all" | "team" | "user">("all");
  const counts = bugsByDay(bugs, days);
  const top = Math.max(1, ...counts);
  const filed = counts.reduce((sum, n) => sum + n, 0);
  const statuses = bugs.map((bug) => bugStatusOf(statusOf(bug)));
  const waiting = statuses.filter((status) => status === "open").length;
  const triage = statuses.filter((status) => status === "triage" || status === "fixing").length;
  const shown = bugs.filter((bug) => {
    const status = bugStatusOf(statusOf(bug));
    if (from !== "all" && bug.reporter !== from) return false;
    if (show === "all") return true;
    if (show === "waiting") return status === "open" || status === "triage" || status === "fixing";
    return status === show;
  });
  return (
    <Card title="Bugs people filed" meta={`${filed} filed in ${days.length} days · ${waiting} waiting · ${triage} with triage`} testID="tex-dashboard-bugs">
      <div className="td-bugbars" role="img" aria-label={`Bug reports filed per day, ${filed} in ${days.length} days`}>
        {counts.map((n, index) => (
          <span key={days[index]} style={{ height: `${n === 0 ? 2 : 8 + (n / top) * 40}px` }} className={n === 0 ? "zero" : undefined} />
        ))}
      </div>
      <div className="td-filters">
        <label className="td-select">
          <span className="td-sr">Show</span>
          <select value={show} onChange={(event) => setShow(event.target.value as typeof show)} data-testid="tex-dashboard-bugs-show">
            <option value="waiting">Waiting on someone</option>
            {BUG_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
            <option value="all">Every report</option>
          </select>
        </label>
        <label className="td-select">
          <span className="td-sr">Filed by</span>
          <select value={from} onChange={(event) => setFrom(event.target.value as typeof from)}>
            <option value="all">Filed by anyone</option>
            <option value="team">The team</option>
            <option value="user">People using Tex</option>
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="td-empty">Nothing here.</p>
      ) : (
        <ul className="td-bugs">
          {shown.slice(0, 50).map((bug) => {
            const status = bugStatusOf(statusOf(bug));
            return (
              <li key={bug.path}>
                <button type="button" onClick={() => onOpen(bug.path)} data-testid="tex-dashboard-bug">
                  <span className="td-bug-title">{bug.title ?? "Bug report"}</span>
                  <span className="td-pain-meta">
                    {bug.filed === null ? "" : shortDate(bug.filed)} · {bug.reporter === "team" ? "team" : "someone using Tex"}
                    {bug.textsShared ? " · texts attached" : ""}
                  </span>
                  <span className={`td-chip ${status}`}>{STATUS_LABELS[status]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

interface Note {
  path: string;
  text: string;
  mail: { at: string; from: string; to: string | null; text: string }[];
}

type Act = "comment" | "triage" | "retire" | "reopen";

/** One report or review, read at the staff member's own clearance, with mail to the triage agent below it. */
export function NoteReader({ path, onClose, onStatus }: { path: string; onClose: () => void; onStatus: (path: string, status: string) => void }) {
  const read = useRef(useAction(api.functions.texDashboard.readNote));
  const act = useRef(useAction(api.functions.texDashboard.act));
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<Act | null>(null);
  const load = useCallback(() => {
    setError(null);
    read.current({ path }).then(setNote, () => setError("This note could not be opened."));
  }, [path]);
  useEffect(() => {
    setNote(null);
    load();
  }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const status = useMemo(() => (note === null ? null : /^---\r?\n[\s\S]*?^status:\s*(.+)$/m.exec(note.text)?.[1]?.trim() ?? null), [note]);
  const run = (action: Act) => {
    setBusy(action);
    setError(null);
    act.current({ path, action, comment })
      .then((answer) => {
        setComment("");
        if (answer.status !== null) onStatus(path, answer.status);
        load();
      })
      .catch(() => setError(action === "comment" ? "Write a comment first, or try again." : "That did not save. Try again."))
      .finally(() => setBusy(null));
  };
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return (
    <div className="td-sheet" role="dialog" aria-modal="true" aria-label={name} data-testid="tex-dashboard-reader">
      <div className="td-sheet-back" onClick={onClose} aria-hidden />
      <div className="td-sheet-body">
        <div className="td-card-head">
          <h2 className="td-h2">{name}</h2>
          <button type="button" className="td-link" onClick={onClose}>
            Close
          </button>
        </div>
        {status !== null ? <span className="td-meta">Status: {status}</span> : null}
        {note === null && error === null ? <p className="td-empty">Opening…</p> : null}
        {note !== null ? <pre className="td-note">{note.text}</pre> : null}
        {note !== null && note.mail.length > 0 ? (
          <div className="td-mail">
            <span className="td-small-h">Notes to and from triage</span>
            {note.mail.map((mail, index) => (
              <div key={`${mail.at}${index}`} className="td-mail-line">
                <span className="td-pain-meta">
                  {mail.from} to {mail.to ?? "everyone"} · {shortDate(Date.parse(mail.at))}
                </span>
                <span>{mail.text}</span>
              </div>
            ))}
          </div>
        ) : null}
        <label className="td-small-h" htmlFor="td-comment">
          Comment for the triage agent
        </label>
        <textarea id="td-comment" className="td-input" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="More detail, what you expected, or why you are retiring it" />
        {error !== null ? <p className="td-error">{error}</p> : null}
        <div className="td-filters">
          <button type="button" className="td-btn" disabled={busy !== null || comment.trim() === ""} onClick={() => run("comment")}>
            {busy === "comment" ? "Saving…" : "Comment"}
          </button>
          <button type="button" className="td-btn primary" disabled={busy !== null} onClick={() => run("triage")} data-testid="tex-dashboard-send-triage">
            {busy === "triage" ? "Sending…" : "Send to triage to fix"}
          </button>
          {status === "retired" ? (
            <button type="button" className="td-btn" disabled={busy !== null} onClick={() => run("reopen")}>
              {busy === "reopen" ? "Reopening…" : "Reopen"}
            </button>
          ) : (
            <button type="button" className="td-btn" disabled={busy !== null} onClick={() => run("retire")}>
              {busy === "retire" ? "Retiring…" : "Retire"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

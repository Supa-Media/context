/**
 * The test chat's "N sandbox writes" menu and the viewer each write opens in (Lab live sandbox, approved mockup
 * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): a page read back from the test chat (op `page`), an email as it
 * would have gone (to, subject, body; never sent), a note's text. Everything here is the test chat's own: Reset throws
 * it away. Text only: a page's Markdown is shown as written, never as HTML.
 */
import { useEffect, useState } from "react";
import { pageIdOf, readSandboxPage, useSandbox, type SandboxWrite } from "../../engine/sandbox";
import { Pop } from "../bar/Pop.web";

const EMAIL = new Set(["email", "draft"]);
/** Whether a write has something to open: a page's address, an email, or a body. */
export const opens = (w: SandboxWrite) => (w.kind === "page" ? !!pageIdOf(w) : EMAIL.has(w.kind) ? !!(w.to || w.subject || w.body) : !!w.body);
const subOf = (w: SandboxWrite) => (w.kind === "page" ? "Working page, gone on Reset" : EMAIL.has(w.kind) ? "Simulated, never sent" : w.kind === "note" ? "In the sandbox copy of your notes" : w.kind);

export function SandboxWrites() {
  const sb = useSandbox();
  const [open, setOpen] = useState<SandboxWrite | null>(null);
  const n = sb.writes.length;
  return (
    <>
      <Pop
        id="sbChanges"
        className="ghost"
        button={
          <>
            <span className="wcount">{n}</span> sandbox write{n === 1 ? "" : "s"} ▾
          </>
        }
      >
        {(close) => (
          <div className="vmenu sbwrites">
            <div className="mh">What Tex wrote in this sandbox</div>
            {n ? (
              sb.writes.map((w, k) =>
                opens(w) ? (
                  <button
                    type="button"
                    className="wr open"
                    key={k}
                    data-write={k}
                    onClick={() => {
                      close();
                      setOpen(w);
                    }}
                  >
                    <span className="wt">
                      {w.title || w.summary}
                      <span className="sub">{subOf(w)}</span>
                    </span>
                    <span className="meta">Open</span>
                  </button>
                ) : (
                  <div className="wr" key={k}>
                    <span className="k">{w.kind}</span>
                    <span>{w.summary || w.title}</span>
                  </div>
                ),
              )
            ) : (
              <div className="mnote">Nothing yet. Notes, emails and pages Tex makes land here.</div>
            )}
            <div className="mnote">
              Reset throws all of these away. <code>tex_dev sandbox writes</code>
            </div>
          </div>
        )}
      </Pop>
      {open ? <WriteViewer w={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

const X = ({ onClose }: { onClose: () => void }) => (
  <button className="ib" id="sbwX" aria-label="Close" onClick={onClose}>
    <svg className="i" viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  </button>
);

/** One write, opened: over the Lab, closed with ×, Escape or a click outside it. */
export function WriteViewer({ w, onClose }: { w: SandboxWrite; onClose: () => void }) {
  const [page, setPage] = useState<{ title: string; text: string } | { error: string } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    if (w.kind !== "page") return;
    let live = true;
    readSandboxPage(pageIdOf(w)).then(
      (p) => live && setPage(p),
      (e: unknown) => live && setPage({ error: e instanceof Error ? e.message : "The page didn't load" }),
    );
    return () => {
      live = false;
    };
  }, [w]);
  let body;
  if (w.kind === "page")
    body = (
      <>
        <div className="mh">
          <b>Sandbox page</b>
          {w.url ? <span className="url">{w.url}</span> : null}
          <span className="spacer" />
          <X onClose={onClose} />
        </div>
        <div className="banner">Live while this sandbox lives. Reset, or 24 hours idle, and the link stops answering.</div>
        <div className="mb">
          {!page ? <div className="mnote">Opening the page…</div> : "error" in page ? <div className="mnote c-bad">{page.error}</div> : <pre className="pagev" id="sbwPage">{page.text}</pre>}
        </div>
      </>
    );
  else if (EMAIL.has(w.kind))
    body = (
      <>
        <div className="mh">
          <b>{w.kind === "draft" ? "Simulated email draft" : "Simulated email"}</b>
          <span className="bdg swr">Never sent</span>
          <span className="spacer" />
          <X onClose={onClose} />
        </div>
        <div className="mb mailv">
          <div className="kv">
            <span>To</span>
            <span>{w.to || "–"}</span>
            <span>From</span>
            <span>You, via Tex</span>
            <span>Subject</span>
            <span>{w.subject || w.title || "(no subject)"}</span>
          </div>
          <div className="mailb">{w.body}</div>
        </div>
      </>
    );
  else
    body = (
      <>
        <div className="mh">
          <b>{w.title || w.summary}</b>
          <span className="bdg swr">Sandbox copy</span>
          <span className="spacer" />
          <X onClose={onClose} />
        </div>
        <div className="mb">
          <pre className="notev">{w.body}</pre>
        </div>
      </>
    );
  return (
    <div className="sbscrim" id="sbWrite" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sbmodal" role="dialog" aria-modal="true" aria-label={w.title || w.kind}>
        {body}
      </div>
    </div>
  );
}

import { trackEvent } from "../../observability/client";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { CONSOLE_ROUTE, LOGIN_ROUTE } from "../../auth/redirect";
import { forgetReceipt, readReceipt } from "./receipt";
import { messagesHref } from "./routes";
import { TEX_TITLE, TexFooter, TexHeader, TexMark } from "./TexLanding.web";
import { TEX_LAUNCH_CSS } from "./texLaunchCss";

/**
 * `/waitlist`: where somebody who joined stands, from the server, live
 * (`waitlistStatus.status`). "You're on the list" with an optional answer to
 * "what would you use Tex for?", then, once staff let them in, "You're in"
 * with their Tex line, a Messages button and the console below it. The
 * states and their copy are the artboards in tex-launch-artboards (2026-10-20).
 *
 * Read with the receipt this browser was handed at joining. No receipt, or one
 * the server does not know, is one calm page that points at sign-in, because
 * a person let in can always sign in with their number.
 */
export const USE_FOR_MAX = 280;

export function TexStatus() {
  useEffect(() => {
    const title = document.title;
    document.title = TEX_TITLE;
    return () => {
      document.title = title;
    };
  }, []);
  const [receipt, setReceipt] = useState<string | null>(() => readReceipt());
  const status = useQuery(api.functions.waitlistStatus.status, receipt === null ? "skip" : { receipt });

  const forget = () => {
    forgetReceipt();
    setReceipt(null);
    window.location.assign("/");
  };
  const header = (
    <TexHeader
      right={
        receipt !== null && status ? (
          <button type="button" className="tx-quiet" onClick={forget} aria-label="Not you? Forget this browser and go back to tex.lc">
            Not you?
          </button>
        ) : null
      }
    />
  );

  let body: React.ReactNode = null;
  if (receipt === null || status === null) body = <NotFound />;
  else if (status === undefined) body = null;
  else if (status.state === "admitted") body = <Admitted line={status.texLine} firstText={status.firstText} />;
  else body = <Waiting receipt={receipt} contact={status.contact} useFor={status.useFor} />;

  return (
    <div className="tx" data-landing="tex-status">
      <style>{TEX_LAUNCH_CSS}</style>
      <div className="tx-status">
        {header}
        <main className="tx-wrap" aria-busy={body === null}>
          {body}
        </main>
        <TexFooter />
      </div>
    </div>
  );
}

type Contact = { kind: "phone"; ending: string } | { kind: "email"; masked: string };

function Waiting({ receipt, contact, useFor }: { receipt: string; contact: Contact; useFor: string | null }) {
  return (
    <>
      <section className="tx-col">
        <TexMark />
        <h1 className="tx-big">You're on the list.</h1>
        <p className="tx-body">
          {contact.kind === "phone" ? (
            <>
              We'll text{" "}
              <strong aria-label={`your number ending in ${contact.ending}`}>•••• {contact.ending}</strong> when it's
              your turn, with Tex's number.
            </>
          ) : (
            <>
              We'll email <strong>{contact.masked}</strong> when it's your turn.
            </>
          )}{" "}
          There's nothing else you need to do.
        </p>
        <p className="tx-small tx-note">
          Tex works in iMessage: you'll save one contact and send one text. No app to install.
        </p>
      </section>
      <Answer receipt={receipt} saved={useFor} />
    </>
  );
}

/**
 * The optional question. Asked after joining and never before, and nothing
 * waits on it: the place is saved whether or not it is answered.
 */
export function Answer({ receipt, saved }: { receipt: string; saved: string | null }) {
  const save = useMutation(api.functions.waitlistStatus.answer);
  const [editing, setEditing] = useState(saved === null);
  const [draft, setDraft] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // An answer saved from another tab arrives here too.
  useEffect(() => {
    if (!editing) setDraft(saved ?? "");
  }, [saved, editing]);

  async function submit() {
    setBusy(true);
    setFailed(false);
    try {
      const { saved: ok } = await save({ receipt, useFor: draft });
      if (ok) setEditing(draft.trim().length === 0);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!editing && saved !== null) {
    return (
      <section className="tx-panel" aria-label="Your answer">
        <div className="tx-panel-row">
          <span className="tx-eyebrow">Your answer</span>
          <button type="button" className="tx-link tx-tap" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        <p className="tx-quote">{saved}</p>
        <p role="status">Saved. You can change it any time.</p>
      </section>
    );
  }

  return (
    <form
      className="tx-panel"
      aria-label="What would you use Tex for?"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void submit();
      }}
    >
      <span className="tx-eyebrow">{saved === null ? "Optional" : "Your answer"}</span>
      <h2>
        <label htmlFor="tx-use-for">What would you use Tex for?</label>
      </h2>
      {saved === null ? (
        <p id="tx-use-for-help">A sentence or two helps us decide who to let in first. Your place on the list is already saved.</p>
      ) : null}
      <textarea
        id="tx-use-for"
        value={draft}
        maxLength={USE_FOR_MAX}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="My kids' schedules, bills, …"
        aria-describedby={saved === null ? "tx-use-for-help" : undefined}
        autoFocus={saved !== null}
      />
      {failed ? (
        <p className="tx-err" role="alert">
          That didn't save. Try again in a moment.
        </p>
      ) : null}
      <div className="tx-panel-row">
        <span className="tx-count" aria-live="polite">
          {draft.length}/{USE_FOR_MAX}
        </span>
        <span className="tx-panel-actions">
          {saved !== null ? (
            <button
              type="button"
              className="tx-link tx-tap"
              onClick={() => {
                setDraft(saved);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          ) : null}
          <button type="submit" className="tx-btn" disabled={busy || (saved === null && draft.trim().length === 0)}>
            Save
          </button>
        </span>
      </div>
    </form>
  );
}

/** `+1 (813) 335-0746` for a North American number, E.164 otherwise: as the "You're in" text writes it. */
export function readableLine(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us === null ? e164 : `+1 (${us[1]}) ${us[2]}-${us[3]}`;
}

/** A one-card vCard for Tex's line, so "Save Tex's contact" is one tap. */
export function texVCard(line: string): string {
  return ["BEGIN:VCARD", "VERSION:3.0", "FN:Tex", "N:;Tex;;;", "ORG:Context", `TEL;TYPE=CELL:${line}`, "URL:https://tex.lc", "END:VCARD", ""].join("\r\n");
}

/**
 * Open Messages at Tex's line ("hi" typed for a first text) and Save Tex's
 * contact, as `/waitlist`'s "You're in" and `/text` both draw them.
 */
export function TexLineActions({ line, firstText }: { line: string; firstText: boolean }) {
  const [card, setCard] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([texVCard(line)], { type: "text/vcard" }));
    setCard(url);
    return () => URL.revokeObjectURL(url);
  }, [line]);
  return (
    <div className="tx-actions tx-actions-near">
      <a className="tx-btn" href={messagesHref(line, firstText)} onClick={() => trackEvent("tex_messages_opened", { first_text: firstText })}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        </svg>
        Open Messages
      </a>
      {card !== null ? (
        <a className="tx-btn tx-btn-line" href={card} download="Tex.vcf" onClick={() => trackEvent("tex_contact_downloaded")}>
          Save Tex's contact
        </a>
      ) : null}
    </div>
  );
}

function Admitted({ line, firstText }: { line: string | null; firstText: boolean }) {
  return (
    <section className="tx-col tx-col-wide">
      <TexMark />
      <h1 className="tx-big">You're in.</h1>
      {line === null ? (
        <p className="tx-body">We're getting your Tex line ready. We'll text you the number.</p>
      ) : (
        <>
          <p className="tx-body">Text Tex at</p>
          <p className="tx-number">{readableLine(line)}</p>
          <TexLineActions line={line} firstText={firstText} />
          <p className="tx-small tx-note-sm">
            Send anything to start, from the iPhone you signed up with. Tex is iMessage only right now; a green-bubble
            text gets a reply asking you to switch.
          </p>
        </>
      )}
      <div className="tx-panel tx-panel-wide">
        <span className="tx-eyebrow">Your notes live here too</span>
        <p className="tx-ink">See what Tex knows about you, in your notes.</p>
        <a className="tx-btn tx-btn-blue" href={CONSOLE_ROUTE}>
          Open console
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </a>
        <span className="tx-mono">{window.location.host}/console</span>
      </div>
    </section>
  );
}

function NotFound() {
  return (
    <section className="tx-col">
      <TexMark />
      <h1 className="tx-big">We can't find your spot from this browser.</h1>
      <p className="tx-body">
        If you joined, you're still on the list and we'll text you when it's your turn. Already let in? Sign in with
        your number.
      </p>
      <div className="tx-actions">
        <a className="tx-btn" href={LOGIN_ROUTE}>
          Sign in
        </a>
        <a className="tx-btn tx-btn-line" href="/">
          Back to tex.lc
        </a>
      </div>
    </section>
  );
}

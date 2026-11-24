/**
 * The people strip pinned over a made-up group chat (artboards 03, 04a and 04 of `group-chat-sim-artboards/`): who is
 * in it (a pill each, with its menu: their workspaces, Write as, and leaving), + Add someone (a join, now, as in a
 * real chat), who is billed, how much Tex joins in, Set up, and on its second row what Tex can see.
 */
import { useState } from "react";
import { sandbox, sendAs, useSandbox } from "../../../engine/sandbox";
import { Pop } from "../../bar/Pop.web";
import { Av, WsChip } from "./parts.web";
import { ACCOUNT_WORDS, changeWords, firstName, MAX_PEOPLE, otherPeople, roleIn, speaksUpWord, standInNumber, workspaces, type Account, type Role, type Slug, type WorldPerson } from "./worldModel";
import { currentDraft, joinPerson, leavePerson, openSetup, useWorld } from "./worldStore";
import { worldNow } from "./worldView";

const ROLE_WORDS: Record<Role, string> = { owner: "Owner", editor: "Editor", member: "Member · read-only" };

function PersonMenu({ p, close, guest }: { p: WorldPerson; close: () => void; guest?: string }) {
  const sb = useSandbox();
  const short = firstName(p.name);
  const idle = !sb.running && !sb.busy;
  return (
    <div className="vmenu">
      <div className="phead">
        <Av name={p.name} account={p.account} />
        <b>{p.name}</b>
        <span className="meta">{ACCOUNT_WORDS[p.account]}</span>
      </div>
      {guest ? <div className="mnote">Tex sees {guest}</div> : null}
      <div className="mh">Workspaces</div>
      {workspaces().map((w) => {
        const r = roleIn(p, w.slug);
        return (
          <div className="mi" key={w.slug}>
            <span className="nm">{w.name}</span>
            <span className={"rl" + (r ? "" : " no")}>{r ? (r.invited ? "Invited by number · " + r.role : ROLE_WORDS[r.role]) : p.account === "on" ? "Not a member" : "Not in it"}</span>
          </div>
        );
      })}
      <hr />
      <button
        className="mi"
        data-as={p.name}
        onClick={() => {
          close();
          sendAs(p.name);
        }}
      >
        ✎ <span className="nm">Text as {short}</span>
      </button>
      <button
        className="mi danger"
        data-leave={p.name}
        disabled={!idle}
        onClick={() => {
          close();
          void leavePerson(p.name);
        }}
      >
        → <span className="nm">{short} leaves the conversation</span>
      </button>
      <div className="mnote">Shows in the chat as &ldquo;{short} left the conversation.&rdquo; What Tex can see changes from the next text.</div>
    </div>
  );
}

const ROLES: Array<Role | ""> = ["owner", "editor", "member", ""];

/** + Add someone: who joins, their account and roles, who adds them, and what it changes before it does. */
function AddSomeone({ here, close, preset }: { here: WorldPerson[]; close: () => void; preset?: WorldPerson }) {
  const sb = useSandbox();
  const others = otherPeople().filter((o) => !here.some((h) => h.name === o.name));
  const [p, setP] = useState<WorldPerson>(() => preset ?? others[0] ?? { name: "", account: "off" });
  const [by, setBy] = useState(() => (here.find((h) => h.name === sandbox.as) ?? here[0])?.name ?? "");
  const nm = p.name.trim();
  const words = nm ? changeWords(here, [...here, p], p, "added") : null;
  const full = here.length >= MAX_PEOPLE;
  const taken = here.some((h) => h.name.toLowerCase() === nm.toLowerCase());
  const setAccount = (a: Account) => setP({ name: p.name, account: a, ...(a === "on" ? { roles: {} } : a === "invited" ? { invited: { slug: workspaces()[0]?.slug ?? "", role: "member" } } : {}) });
  return (
    <div className="vmenu" id="sbAddMenu">
      <div className="mh">Add someone to the chat</div>
      <div className="addf">
        <label htmlFor="sbAddName">Name</label>
        <input id="sbAddName" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} autoFocus />
        <label htmlFor="sbAddNum">Number</label>
        <input id="sbAddNum" className="num" value={standInNumber(here.length)} readOnly title="A stand-in: the preview gives each person their own number" />
        <label htmlFor="sbAddAcct">Account</label>
        <select id="sbAddAcct" value={p.account} onChange={(e) => setAccount(e.target.value as Account)}>
          <option value="off">Not on Context</option>
          <option value="on">On Context</option>
          <option value="invited">Invited by number</option>
        </select>
        {p.account === "on" ? (
          <>
            <label>Workspaces</label>
            <span className="ws3">
              {workspaces().map((w) => (
                <select key={w.slug} aria-label={w.name} title={w.name} value={p.roles?.[w.slug] ?? ""} onChange={(e) => setP({ ...p, roles: { ...p.roles, [w.slug]: (e.target.value || undefined) as Role | undefined } })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {w.name.split(" ")[0]}: {r ? r[0].toUpperCase() + r.slice(1) : "no"}
                    </option>
                  ))}
                </select>
              ))}
            </span>
          </>
        ) : p.account === "invited" ? (
          <>
            <label htmlFor="sbAddInv">Invited to</label>
            <select id="sbAddInv" value={p.invited?.slug ?? workspaces()[0]?.slug ?? ""} onChange={(e) => setP({ ...p, invited: { slug: e.target.value as Slug, role: p.invited?.role ?? "member" } })}>
              {workspaces().map((w) => (
                <option key={w.slug} value={w.slug}>
                  {w.name}, as a member
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor="sbAddBy">Added by</label>
        <select id="sbAddBy" value={by} onChange={(e) => setBy(e.target.value)}>
          {here.map((h) => (
            <option key={h.name}>{h.name}</option>
          ))}
        </select>
      </div>
      <div className="prev">Joins now, as in a real chat. {words ? words.map((s, i) => (s.b ? <b key={i}>{s.t}</b> : <span key={i}>{s.t}</span>)) : <span>What Tex can see stays the same.</span>}</div>
      {full ? <div className="mnote">A made-up chat has at most {MAX_PEOPLE} people.</div> : taken ? <div className="mnote">{nm} is already here.</div> : null}
      <div className="addft">
        <button className="ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="primary"
          id="sbAddGo"
          disabled={!nm || taken || full || !!sb.running || sb.busy}
          onClick={() => {
            close();
            void joinPerson({ ...p, name: nm }, by);
          }}
        >
          Add {firstName(nm) || "them"}
        </button>
      </div>
      {others.length ? (
        <>
          <hr />
          <div className="mnote">
            Or pick someone from the made-up world:{" "}
            {others.map((o, i) => (
              <span key={o.name}>
                {i ? ", " : ""}
                <button className="pick" onClick={() => setP(JSON.parse(JSON.stringify(o)))}>
                  {o.name}
                </button>
              </span>
            ))}
            .
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PeopleStrip() {
  const sb = useSandbox();
  const w = useWorld();
  const now = worldNow(sb, w);
  const sponsor = w.settings?.sponsor ? firstName(w.settings.sponsor) : "";
  const then = w.settings?.then && !now.here.some((p) => p.name === w.settings?.then?.name) ? w.settings.then : undefined;
  const setUp = () => {
    const d = currentDraft(now.here);
    if (d) openSetup(d);
  };
  return (
    <div className="gstrip" id="sbPeople">
      <div className="gr">
        <span className="lbl">In this chat</span>
        {now.here.map((p) => {
          const g = now.guest(p.name);
          const meta =
            sponsor && firstName(p.name) === sponsor
              ? { t: "brought Tex in", c: "in" }
              : now.newcomer === p.name
                ? { t: p.account === "on" ? "joined" : "joined · not on Context", c: "" }
                : p.account === "off"
                  ? { t: "Not on Context" + (g ? " · " + g : ""), c: "" }
                  : p.account === "invited"
                    ? { t: "Invited by number", c: "" }
                    : null;
          return (
            <Pop
              key={p.name}
              id={"sbP-" + p.name.replace(/\W+/g, "")}
              className={"pchip" + (now.newcomer === p.name ? " new" : "")}
              title={`${p.name} · ${ACCOUNT_WORDS[p.account]}`}
              button={
                <>
                  <Av name={p.name} account={p.account} />
                  <span>{firstName(p.name)}</span>
                  {meta ? <span className={"pm " + meta.c}>{meta.t}</span> : null}
                </>
              }
            >
              {(close) => <PersonMenu p={p} close={close} guest={g} />}
            </Pop>
          );
        })}
        <Pop id="sbAddP" className="addp" title="Someone joins now, as in a real chat" button="+ Add someone">
          {(close) => <AddSomeone here={now.here} close={close} preset={then} />}
        </Pop>
        {then ? <span className="wait">Then: add {then.name}</span> : null}
        <span className="end">
          {sponsor ? <span className="bill">Billed to {sponsor}</span> : null}
          <button className="chipbtn" id="sbJoin" title="How much Tex joins in, in this chat: change it in Set up" onClick={setUp}>
            <span className="k">Tex joins in:</span> <span>{speaksUpWord(w.settings?.speaksUp ?? "attentive")}</span>
            <span className="car">▾</span>
          </button>
          <button className="ghost" id="sbSetup" title="Change people, roles and settings: starts the chat again" onClick={setUp}>
            Set up
          </button>
        </span>
      </div>
      <div className="gr see">
        <span className="lbl">Tex can see</span>
        {now.chips ? now.chips.map((c, i) => <WsChip key={c.kind === "home" ? "home" : c.slug + i} c={c} />) : <span className="wait">Shows after the first text, from the preview&apos;s answer</span>}
      </div>
    </div>
  );
}

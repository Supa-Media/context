/**
 * The setup of a made-up group chat, in the dock in the grid's place (artboard 02 of `group-chat-sim-artboards/`):
 * the people (name, account, a role in each made-up workspace), what Tex can see with them, live, and the chat's
 * settings (name, who brings Tex in, how much Tex joins in, whether it has introduced itself, what it starts from).
 * Nothing runs until "Open the group chat".
 */
import { useEffect, useState } from "react";
import { useSandbox } from "../../../engine/sandbox";
import { useLab } from "../../../store";
import { Av, WsChip } from "./parts.web";
import { draftProblem, MAX_PEOPLE, seeChips, SPEAKS_UP, standInNumber, workspaces, type Account, type Role, type Slug, type StartLine, type WorldDraft, type WorldPerson } from "./worldModel";
import { closeSetup, editSetup, fitDraft, loadWorkspaces, openWorld, undoSetup, useWorld } from "./worldStore";

/** One workspace's cell for one person: their role, their invitation, or nothing. */
function RoleCell({ p, i, slug }: { p: WorldPerson; i: number; slug: Slug }) {
  const set = (f: (q: WorldPerson) => void) => editSetup((d) => f(d.people[i]));
  if (p.account === "off")
    return (
      <select className="none" disabled aria-label="Not in it: not on Context">
        <option>Not in it</option>
      </select>
    );
  if (p.account === "invited") {
    const v = p.invited?.slug === slug ? p.invited.role : "";
    return (
      <select
        className={v ? "" : "none"}
        value={v}
        aria-label={"Invited to " + slug}
        onChange={(e) =>
          set((q) => {
            if (e.target.value) q.invited = { slug, role: e.target.value as "member" | "editor" };
            else if (q.invited?.slug === slug) delete q.invited;
          })
        }
      >
        <option value="">Not in it</option>
        <option value="member">Member, invited</option>
        <option value="editor">Editor, invited</option>
      </select>
    );
  }
  const v = p.roles?.[slug] ?? "";
  return (
    <select
      className={v ? "" : "none"}
      value={v}
      aria-label={p.name + "'s role in " + slug}
      onChange={(e) =>
        set((q) => {
          q.roles = { ...q.roles, [slug]: (e.target.value || undefined) as Role | undefined };
          if (!e.target.value) delete q.roles[slug];
        })
      }
    >
      <option value="owner">Owner</option>
      <option value="editor">Editor</option>
      <option value="member">Member</option>
      <option value="">Not in it</option>
    </select>
  );
}

function People({ d }: { d: WorldDraft }) {
  const setAccount = (i: number, a: Account) =>
    editSetup((x) => {
      const q = x.people[i];
      x.people[i] = { name: q.name, account: a, ...(a === "on" ? { roles: {} } : a === "invited" ? { invited: { slug: workspaces()[0]?.slug ?? "", role: "member" } } : {}) };
      if (a !== "on" && x.sponsor === q.name) x.sponsor = x.people.find((p) => p.account === "on")?.name ?? "";
    });
  return (
    <div className="gl">
      <h4>
        People <span>Their own setups: whether they&apos;re on Context, and their role in each workspace</span>
      </h4>
      <table className="ptab" id="sbPeopleTab">
        <colgroup>
          <col />
          <col style={{ width: 146 }} />
          {workspaces().map((w) => (
            <col key={w.slug} style={{ width: 136 }} />
          ))}
          <col style={{ width: 30 }} />
        </colgroup>
        <thead>
          <tr>
            <th>Person</th>
            <th>Account</th>
            {workspaces().map((w) => (
              <th key={w.slug}>{w.name}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {d.people.map((p, i) => (
            <tr key={i}>
              <td className="nm">
                <Av name={p.name || "?"} account={p.account} />
                <input
                  aria-label="Name"
                  value={p.name}
                  onChange={(e) =>
                    editSetup((x) => {
                      if (x.sponsor === x.people[i].name) x.sponsor = e.target.value;
                      x.people[i].name = e.target.value;
                    })
                  }
                />
                {p.account !== "on" ? (
                  <span className="ph2" title="A stand-in: each made-up person gets a number of their own">
                    {standInNumber(i)}
                  </span>
                ) : null}
              </td>
              <td>
                <select aria-label="Account" value={p.account} onChange={(e) => setAccount(i, e.target.value as Account)}>
                  <option value="on">On Context</option>
                  <option value="off">Not on Context</option>
                  <option value="invited" disabled={workspaces().length === 0}>
                    Invited by number
                  </option>
                </select>
              </td>
              {workspaces().map((w) => (
                <td key={w.slug}>
                  <RoleCell p={p} i={i} slug={w.slug} />
                </td>
              ))}
              <td>
                <button className="xb" aria-label={"Remove " + p.name} disabled={d.people.length <= 1} onClick={() => editSetup((x) => void x.people.splice(i, 1))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="addrow">
        <button className="addp" id="sbSetupAdd" disabled={d.people.length >= MAX_PEOPLE} onClick={() => editSetup((x) => void x.people.push({ name: "", account: "off" }))}>
          + Add someone
        </button>
      </div>
      <div className="seeline" id="sbSeeLine">
        <span className="lbl">Tex can see, with these people</span>
        <div className="chips">
          {seeChips(d.people.filter((p) => p.name.trim())).map((c, k) => (
            <WsChip key={k} c={c} />
          ))}
        </div>
        <div className="rule">A workspace counts only if everyone here is in it (or invited to it by number), and Tex gets the lowest role among them: a member means read-only. Personal workspaces never count.</div>
      </div>
    </div>
  );
}

const linesOf = (t: string, people: WorldPerson[]): StartLine[] =>
  t.split("\n").flatMap((l) => {
    const m = /^\s*([^:]{1,40}):\s*(.+)$/.exec(l);
    const who = m ? people.find((p) => p.name.toLowerCase() === m[1].trim().toLowerCase() || p.name.split(" ")[0].toLowerCase() === m[1].trim().toLowerCase()) : undefined;
    return m && who ? [{ as: who.name, text: m[2].trim() }] : [];
  });

function Settings({ d }: { d: WorldDraft }) {
  const sb = useSandbox();
  const w = useWorld();
  const [start, setStart] = useState<"empty" | "kept" | "chat" | "write">(d.start.length ? "kept" : "empty");
  const [writing, setWriting] = useState(() => d.start.map((l) => `${l.as}: ${l.text}`).join("\n"));
  const fromChat = sb.rows.filter((r) => !r.tex && !r.kind && r.text && d.people.some((p) => p.name === r.who)).map((r) => ({ as: r.who, text: r.text }));
  const level = SPEAKS_UP.find((x) => x.v === d.speaksUp) ?? SPEAKS_UP[2];
  const pickStart = (v: typeof start) => {
    setStart(v);
    editSetup((x) => {
      x.start = v === "empty" ? [] : v === "chat" ? fromChat : v === "write" ? linesOf(writing, x.people) : (w.base?.start ?? []);
    });
  };
  return (
    <div className="gr2">
      <div className="fset" id="sbSetupForm">
        <label htmlFor="sbWName">Name</label>
        <div>
          <input id="sbWName" value={d.name} placeholder={d.people.map((p) => p.name.split(" ")[0]).join(", ")} onChange={(e) => editSetup((x) => void (x.name = e.target.value))} />
        </div>
        <label htmlFor="sbWSponsor">Brings Tex in</label>
        <div>
          <select id="sbWSponsor" value={d.sponsor} onChange={(e) => editSetup((x) => void (x.sponsor = e.target.value))}>
            {d.people
              .filter((p) => p.account === "on" && p.name.trim())
              .map((p) => (
                <option key={p.name}>{p.name}</option>
              ))}
          </select>
          <span className="tip">The first person on Context to add Tex. Tex&apos;s texts here are billed to them.</span>
        </div>
        <label>Tex joins in</label>
        <div>
          <div className="seg" id="sbWSpeaks">
            {SPEAKS_UP.map((x) => (
              <button key={x.v} type="button" aria-pressed={d.speaksUp === x.v} onClick={() => editSetup((y) => void (y.speaksUp = x.v))}>
                {x.w}
              </button>
            ))}
          </div>
          <span className="tip">{level.tip}</span>
        </div>
        <label>Tex is</label>
        <div>
          <div className="seg">
            <button type="button" aria-pressed={!d.introduced} onClick={() => editSetup((y) => void (y.introduced = false))}>
              Just added
            </button>
            <button type="button" aria-pressed={d.introduced} onClick={() => editSetup((y) => void (y.introduced = true))}>
              Already introduced
            </button>
          </div>
          <span className="tip">{d.introduced ? "Already introduced: Tex has said hello here before, and answers as it would in a chat it knows." : "Just added: Tex says hello once, on its first text here."}</span>
        </div>
        <label htmlFor="sbWStart">Start from</label>
        <div>
          <select id="sbWStart" value={start} onChange={(e) => pickStart(e.target.value as typeof start)}>
            <option value="empty">A new, empty chat</option>
            {w.base?.start.length ? <option value="kept">{`Earlier texts: ${w.base.preset ?? "the scenario"}'s ${w.base.start.length}`}</option> : null}
            {fromChat.length ? <option value="chat">{`Earlier texts: the ${fromChat.length} in the test chat open now`}</option> : null}
            <option value="write">Earlier texts I write</option>
          </select>
          {start === "write" ? (
            <textarea
              aria-label="Earlier texts, one a line, as Name: text"
              placeholder={"Alpha: Saturday still on?\nBeta: yes!"}
              value={writing}
              onChange={(e) => {
                setWriting(e.target.value);
                editSetup((x) => void (x.start = linesOf(e.target.value, x.people)));
              }}
            />
          ) : null}
          <span className="tip">Earlier texts are ones Tex has already seen: said before it was added, so no turn runs on them. {d.start.length ? `${d.start.length} text${d.start.length === 1 ? "" : "s"}.` : ""}</span>
        </div>
      </div>
    </div>
  );
}

/** The setup in the dock, and its footer. */
export function WorldSetup() {
  const w = useWorld();
  const sb = useSandbox();
  const s = useLab();
  const main = sb.code === "main";
  // Code changed while the setup is open: its columns are the workspaces there, and roles in others are dropped.
  useEffect(() => void loadWorkspaces(main).then((ok) => ok && fitDraft()), [main]);
  const d = w.draft;
  if (!d) return null;
  const problem = draftProblem(d);
  const changed = !!w.base && JSON.stringify(w.base) !== JSON.stringify(d);
  const again = sb.source.kind === "world" && sb.rows.some((r) => !r.prod);
  return (
    <>
      <div className="gset" id="sbSetupView">
        <People d={d} />
        <Settings d={d} />
      </div>
      <div className="gfoot">
        {d.preset ? (
          <span className="from">
            Filled in from <b>{d.preset}</b> ·{" "}
            <a style={{ color: changed ? "var(--accent)" : undefined }} aria-disabled={!changed} onClick={() => changed && undoSetup()}>
              Undo my changes
            </a>
          </span>
        ) : null}
        <span className="sp" />
        {problem ? <span className="bad">{problem}</span> : <span className="fnote">{main ? "Made-up people in your own workspaces; nothing Tex writes leaves this chat." : "Made-up people; nothing reaches real chats."}</span>}
        <button className="ghost" onClick={closeSetup}>
          Cancel
        </button>
        <button className="primary" id="sbWorldOpen" disabled={!!problem || sb.busy} onClick={() => void openWorld(d, s.cur.id)}>
          {again ? "Start again with these" : "Open the group chat"}
        </button>
      </div>
    </>
  );
}

/**
 * People's HTML: the artifact's `P.people()` and `P.people.props()`, with the same markup, classes
 * and wording. Every value from the database goes through `esc` (kit) or a helper that does.
 */
import { S } from "../../state";
import { ic, esc, money, plural, pill, sw, panel, confirmBox, pop, handleLine } from "../../kit";
import {
  CAME_LABEL,
  INVITE_TEXT,
  ROLE_LABEL,
  STATUS,
  ago,
  countOf,
  displayName,
  fmtDate,
  pickable,
  rowsOf,
  texOn,
  texView,
  visibleRows,
  type AiAccount,
  type InviteRow,
  type PeopleData,
  type Person,
  type Row,
  type TexView,
} from "./model";

const STATUS_OPTS: Array<[string, string]> = [
  ["all", "Everyone"],
  ["acct", "Signed up"],
  ["waiting", "Waiting"],
  ["in", "Let in"],
  ["invited", "Invited"],
  ["removed", "Removed"],
  ["archived", "Archived"],
];
const FROM_OPTS: Array<[string, string]> = [
  ["all", "Came from anywhere"],
  ["Waitlist", "From the waitlist"],
  ["Friend", "Invited by a friend"],
  ["Ad", "From an ad"],
  ["Staff", "Added by staff"],
];

/** The artifact's `sw`, drawn switched off (the switch cannot be pressed). */
const swOff = (on: boolean, act: string, id: string, label: string) => sw(on, act, id, label).replace('class="sw"', 'class="sw" disabled');

/** The query's words, marked where they match, everything else escaped. */
export function highlight(text: string, query: string): string {
  if (!query) return esc(text);
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += esc(text.slice(last, at)) + `<mark>${esc(m[0])}</mark>`;
    last = at + m[0].length;
  }
  return out + esc(text.slice(last));
}

const hl = (t: string) => highlight(t, S.q);

const tog = (act: string, on: boolean, label: string, v?: string) =>
  `<button class="ghost" aria-pressed="${on}" data-act="${act}"${v != null ? ` data-v="${v}"` : ""} style="${on ? "border-color:var(--accent);color:var(--accent)" : ""}">${label}</button>`;

function bulkActions(nLet: number, nTell: number, nRm: number): string {
  if (S.confirm === "letin") return confirmBox(`Let ${plural(nLet, "person", "people")} in? Each gets one email or text.`, "Let in", "letin");
  if (S.confirm === "tell") return confirmBox(`Text ${plural(nTell, "person", "people")} that they're in?`, "Text them", "tell");
  if (S.confirm === "remove") return confirmBox(`Remove ${plural(nRm, "person", "people")} from the waitlist? They are not told.`, "Remove", "remove", "", true);
  return `${nLet ? `<button class="primary" data-act="askbulk" data-v="letin">Let ${nLet} in</button>` : ""}${nTell ? `<button class="primary" data-act="askbulk" data-v="tell">Text ${nTell} they're in</button>` : ""}${nRm ? `<button class="ghost danger" data-act="askbulk" data-v="remove">Remove ${nRm}</button>` : ""}<button class="link" data-act="clearsel">Clear</button>`;
}

/** The switch in a person's row and the props panel: what it shows depends on what Tex's list says. */
function texSwitch(p: Person, tv: TexView, noPhone: string): string {
  if (tv.state === "loading" || tv.state === "not_connected" || tv.state === "error") return `<span class="sub">—</span>`;
  const label = `Tex access for ${displayName(p)}`;
  if (tv.state === "unlimited") return p.phone === null ? `<span class="sub">${esc(noPhone)}</span>` : swOff(true, "tex", p.userId, label);
  // Adding needs a phone; taking off works for a texting phone too, so an on switch always shows.
  const on = texOn(p, tv);
  if (p.phone === null && !on) return `<span class="sub">${esc(noPhone)}</span>`;
  return on || !tv.full ? sw(on, "tex", p.userId, label) : swOff(false, "tex", p.userId, label);
}

function actCell(r: Row, tv: TexView): string {
  if (r.k === "acct" && r.p) return texSwitch(r.p, tv, "no phone");
  if (r.st === "waiting") {
    return S.confirm === "let" + r.id
      ? confirmBox(`Let ${esc(r.name)} in? They get one ${r.name.includes("@") ? "email" : "text"}.`, "Let in", "letone", r.id)
      : `<button class="ghost" data-act="asklet" data-id="${esc(r.id)}">Let in</button>`;
  }
  if (r.st === "invited" && r.invStatus === "pending") {
    return S.confirm === "rv" + r.id
      ? confirmBox(`Revoke the invite to ${esc(r.name)}? The link stops working.`, "Revoke", "revoke", r.id, true)
      : `<button class="ghost" data-act="askrevoke" data-id="${esc(r.id)}">Revoke</button>`;
  }
  return "";
}

function persCell(r: Row): string {
  const head =
    r.k === "acct"
      ? `<span class="who"><span class="av">${esc((r.name || "?")[0])}</span><span style="min-width:0"><span class="nm">${hl(r.name)}</span> <span class="sub">${esc(r.sub)}</span></span></span>`
      : `<span class="nm">${hl(r.name)}</span>${r.st === "in" && !r.told ? " " + pill("not told", "warn") : ""}${r.why ? `<div class="sub ponly">${hl(r.why)}</div>` : ""}`;
  return `${head}<div class="ponly" style="margin-top:2px">${pill(...STATUS[r.st])}</div>`;
}

function detail(r: Row): string {
  if (r.k === "inv") return `<span class="sub">${esc(r.invStatus ? INVITE_TEXT[r.invStatus].toLowerCase() : "")}</span>`;
  return r.why ? hl(r.why) : `<span class="sub">no answer</span>`;
}

function wsPop(p: Person, name: string): string {
  const rows = p.workspaces
    .map((w) => `<span class="pr"><span>@${esc(w.slug)}</span><span class="sub">${esc(w.kind)} · ${esc(ROLE_LABEL[w.role])}</span></span>`)
    .join("");
  return pop(String(p.workspaces.length), rows, "Workspaces of " + name);
}

function clientsPop(p: Person, name: string, now: number): string {
  if (p.clients.length === 0) return `<span class="sub">none</span>`;
  const rows = p.clients
    .map((c) => `<span class="pr"><span>${esc(c.name)}</span><span class="sub">${c.lastUsedAt === null ? "never used" : esc(ago(c.lastUsedAt, now))}</span></span>`)
    .join("");
  return pop(String(p.clients.length), rows, "AI clients of " + name);
}

function aiPop(p: Person, name: string, rowId: string): string {
  if (!(p.aiUsd > 0)) return `<span class="sub">$0</span>`;
  const rows =
    p.aiByFeature.map((f) => `<span class="pr"><span>${esc(f.label)}</span><span>${money(f.usd)}</span></span>`).join("") +
    `<button class="link" data-act="gocost" data-id="${esc(rowId)}" style="margin-top:6px">Open in AI costs</button>`;
  return pop(money(p.aiUsd), rows, "AI cost of " + name);
}

function rowHtml(r: Row, tv: TexView, now: number): string {
  const open = r.k !== "wl";
  const attrs = open ? ` class="click" tabindex="0" data-act="sel" data-id="${esc(r.id)}" aria-selected="${S.x === r.id}"` : "";
  const check = pickable(r)
    ? `<input type="checkbox" data-act="pick" data-id="${esc(r.id)}" ${S.sel.has(r.id) ? "checked" : ""} aria-label="Select ${esc(r.name)}">`
    : "";
  const from = r.by ? pill(`invited by @${r.by}`, "team") : esc(r.from);
  const cells =
    r.k === "acct" && r.p
      ? `<td class="r hp" data-stop>${wsPop(r.p, r.name)}</td><td class="r hp" data-stop>${clientsPop(r.p, r.name, now)}</td><td class="r hp" data-stop>${aiPop(r.p, r.name, r.id)}</td>`
      : `<td class="wrap hp" colspan="3">${detail(r)}</td>`;
  return `<tr${attrs}><td data-stop>${check}</td><td class="wrap">${persCell(r)}</td><td class="hp">${pill(...STATUS[r.st])}</td><td class="hp">${esc(r.when)}</td><td class="hp">${from}</td>${cells}<td class="r" data-stop>${actCell(r, tv)}</td></tr>`;
}

/** The "Numbers with no account" panel: what Tex's list holds for nobody. */
function linePanel(tv: TexView, texOnCount: number): string {
  let meta = "";
  let body: string;
  switch (tv.state) {
    case "loading":
      body = `<div class="sub">Loading</div>`;
      break;
    case "not_connected":
      meta = "Tex: Linq not connected";
      body = `<div class="sub">none</div>`;
      break;
    case "error":
      meta = "Tex: could not be read";
      body = `<div class="sub">${esc(tv.error)}</div>`;
      break;
    case "unlimited":
      meta = `Tex line: ${texOnCount} used`;
      body = `<div class="sub">none</div>`;
      break;
    case "shared": {
      meta = `Tex line: ${tv.used} of ${tv.cap} used`;
      const unowned = tv.unowned
        .map(
          (n) =>
            `<div class="row" style="min-height:40px"><span class="mono" style="flex:1">${esc(n)}</span>${
              S.confirm === "un" + n
                ? confirmBox("Stop it texting Tex?", "Remove", "unown", n, true)
                : `<button class="ghost" data-act="askunown" data-id="${esc(n)}">Remove</button>`
            }</div>`,
        )
        .join("");
      body = `${unowned || `<div class="sub">none</div>`}<div class="row" style="margin-top:8px"><input class="search" id="newnum" placeholder="+1 555 555 0100" aria-label="Phone number"><button class="ghost" data-act="addnum">Let it text Tex</button></div>`;
      break;
    }
  }
  return panel("p-line", "Numbers with no account", esc(meta), body);
}

function limitsHtml(acct: AiAccount | null | undefined): string {
  if (acct === undefined) return `<div class="sub">Loading</div>`;
  if (acct === null || acct.today.length === 0) return `<div class="sub">none</div>`;
  return `<div class="fun">${acct.today
    .map((t) => {
      const pct = t.cap > 0 ? Math.min(100, (t.used / t.cap) * 100) : 0;
      return `<div class="r"><span>${esc(t.label)}</span><span class="tr"><span class="bb" style="width:${pct}%"></span></span><span class="t">${esc(t.used)} of ${esc(t.cap)}</span></div>`;
    })
    .join("")}</div>`;
}

/** The artifact's `P.people()`: the tools row, the add form, the banners, the bulk bar and the table. */
export function render(d: PeopleData | undefined, now = Date.now()): string {
  const people = d?.people;
  const ps = S.f.ps;
  const cf = S.f.cf;
  const tv = texView(d?.tex);
  const all = people ? rowsOf(people) : [];
  const rows = people ? visibleRows(all, S.f, S.q) : [];
  const selectable = rows.filter(pickable);
  if (people) for (const id of [...S.sel]) if (!selectable.some((r) => r.id === id)) S.sel.delete(id);
  const chosen = all.filter((r) => S.sel.has(r.id));
  const nLet = chosen.filter((r) => r.st === "waiting" || r.st === "removed").length;
  const nTell = chosen.filter((r) => r.st === "in").length;
  const nRm = chosen.filter((r) => r.st === "waiting").length;
  const untold = all.filter((r) => r.st === "in" && !r.told).length;
  const invitesOn = people ? !people.invitesOff : false;

  const tools = `<div class="tools"><input class="search" id="q" placeholder="Search people" title="Name, @handle, email, phone or answer" value="${esc(S.q)}" data-act="q"><select class="search" style="max-width:170px" data-act="psel" aria-label="Status">${STATUS_OPTS.map(
    ([v, l]) => `<option value="${v}" ${ps === v ? "selected" : ""}>${l}${people ? ` (${countOf(all, v)})` : ""}</option>`,
  ).join("")}</select><select class="search" style="max-width:190px" data-act="cf" aria-label="Came from">${FROM_OPTS.map(
    ([v, l]) => `<option value="${v}" ${cf === v ? "selected" : ""}>${l}</option>`,
  ).join("")}</select>${tog("answered", S.f.ans === "1", "Answered the question")}${tog("toldf", S.f.told === "no", "Never told they're in", S.f.told === "no" ? "all" : "no")}${
    ps === "invited" && people ? `<span class="row sub" style="gap:6px">Friends can invite ${sw(invitesOn, "invon", "x", "Friends can invite")}</span>` : ""
  }<span class="spacer"></span><button class="primary" data-act="addppl">Add people</button></div>`;

  if (!people) return tools + `<div class="pn"><div class="empty">Loading</div></div>`;

  const adding = S.adding
    ? `<div class="pn" style="padding:12px;display:flex;flex-direction:column;gap:8px"><label class="field">Emails or phones, one per line<textarea id="addbox" placeholder="dana@example.com&#10;+1 555 555 0100"></textarea></label><div class="row"><button class="primary" data-act="addgo">Let them in</button><button class="ghost" data-act="addcancel">Cancel</button><span class="sub">Each gets one email or text.</span></div></div>`
    : "";
  const truncated = people.truncated
    ? `<div class="banner"><span class="tx">Showing the newest people only; some were left out.</span></div>`
    : "";
  const untoldBanner =
    untold > 0 && S.f.told !== "no" && (ps === "all" || ps === "in")
      ? `<div class="banner"><span class="tx"><b>${plural(untold, "person was", "people were")}</b> let in by phone but never got the text.</span><button class="ghost" data-act="toldf" data-v="no">Show them</button></div>`
      : "";
  const bulk = S.sel.size ? `<div class="bulk"><b>${S.sel.size} selected</b>${bulkActions(nLet, nTell, nRm)}</div>` : "";
  const head = `<tr><th style="width:36px">${selectable.length ? `<input type="checkbox" data-act="selall" aria-label="Select all you can act on" ${selectable.every((r) => S.sel.has(r.id)) ? "checked" : ""}>` : ""}</th><th>Person</th><th class="hp">Status</th><th class="hp">Since</th><th class="hp">From</th><th class="r hp">Workspaces</th><th class="r hp">AI clients</th><th class="r hp">AI cost</th><th></th></tr>`;
  const body = rows.map((r) => rowHtml(r, tv, now)).join("") || `<tr><td colspan="9" class="empty">Nobody matches</td></tr>`;
  const texOnCount = all.filter((r) => r.p !== null && texOn(r.p, tv)).length;
  const line = ps === "all" || ps === "acct" ? linePanel(tv, texOnCount) : "";

  return `${tools}${adding}${truncated}${untoldBanner}${bulk}<div class="pn"><div class="tbl"><table>${head}${body}</table></div></div>${line}`;
}

function camePill(p: Person): string {
  return p.from === "friend" && p.invitedBy ? pill(`invited by @${p.invitedBy}`, "team") : esc(CAME_LABEL[p.from]);
}

function accountProps(d: PeopleData, p: Person, tv: TexView, now: number): string {
  const name = displayName(p);
  const editing = S.confirm === "phone";
  const mailOpen = d.mailOpen.has(p.userId)
    ? `<div class="ppb"><div class="row"><span style="flex:1">Their mail inbox takes mail from anyone</span><button class="ghost" data-act="mailclose" data-id="${esc(p.userId)}">Known senders only</button></div></div>`
    : "";
  const sub = `${p.handle ? esc("@" + p.handle) + " · " : ""}joined ${esc(fmtDate(p.joinedAt))}`;
  return `<div class="pph"><span class="av">${esc((name || "?")[0])}</span><h3 tabindex="-1">${esc(name)}<div class="sub">${sub}</div></h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>
 <div class="ppb"><div class="h">Email</div>${p.emails.map((e, i) => `<div class="row"><span style="flex:1;overflow-wrap:anywhere">${esc(e)}</span>${i ? "" : pill("mail goes here")}</div>`).join("")}</div>
 <div class="ppb"><div class="row"><span class="h" style="flex:1">Phone</span>${editing ? "" : `<button class="link" data-act="phone">${p.phone ? "Change" : "Add"}</button>`}</div>${
   editing
     ? `<div class="row"><input class="search" id="ph" value="${esc(p.phone)}" placeholder="+1 …" style="max-width:none" aria-label="Phone"><button class="primary" data-act="phonesave" data-id="${esc(p.userId)}">Save</button>${p.phone ? `<button class="ghost danger" data-act="phonerm" data-id="${esc(p.userId)}">Remove</button>` : ""}<button class="ghost" data-act="cancel">Cancel</button></div>`
     : `<span class="mono">${esc(p.phone ?? "none")}</span>`
 }
 <div class="row"><span style="flex:1">Can text Tex</span>${texSwitch(p, tv, "needs a phone")}</div></div>
 ${mailOpen}<div class="ppb"><div class="h">Workspaces</div>${p.workspaces.map((w) => `<div class="row"><span style="flex:1">@${esc(w.slug)}</span>${pill(w.kind, w.kind === "personal" ? "ok" : "")}${pill(ROLE_LABEL[w.role])}</div>`).join("")}</div>
 <div class="ppb"><div class="h">Today against today's limits</div>${limitsHtml(d.acct)}</div>
 <div class="kv"><span class="k">Last seen</span><span class="v">${p.lastSeenAt === null ? "never" : esc(ago(p.lastSeenAt, now))}</span><span class="k">AI cost</span><span class="v"><button class="link" data-act="gocost" data-id="${esc(p.userId)}">${money(p.aiUsd)} in 30 days</button></span><span class="k">Their turns</span><span class="v"><button class="link" data-act="theirturns" data-id="${esc(p.handle ?? name)}">See in Turns</button></span><span class="k">Came from</span><span class="v">${camePill(p)}</span></div>
 <div class="row"><button class="ghost${p.archived ? "" : " danger"}" data-act="archive" data-id="${esc(p.userId)}">${p.archived ? "Unarchive" : "Archive"}</button><span class="sub">${p.archived ? "" : "Hides them from People and Growth; deletes nothing"}</span></div>`;
}

function inviteProps(i: InviteRow): string {
  const by = i.inviterHandle ? `@${i.inviterHandle}` : "an account that no longer exists";
  return `<div class="pph"><h3 tabindex="-1">${esc(i.to)}</h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>
 <div class="ppb"><div class="h">How they got here</div><div class="thr"><div>Invited by <b>${esc(by)}</b> on ${esc(fmtDate(i.sentAt))}</div><div>${esc(INVITE_TEXT[i.status])}</div></div></div>`;
}

/** The artifact's `P.people.props(id)`: the side panel's HTML for one picked row, or null. */
export function props(d: PeopleData | undefined, x: string, now = Date.now()): string | null {
  const people = d?.people;
  if (!d || !people) return null;
  const p = people.accounts.find((a) => a.userId === x);
  if (p) return accountProps(d, p, texView(d.tex), now);
  const inv = people.invites.find((i) => i.id === x);
  return inv ? inviteProps(inv) : null;
}

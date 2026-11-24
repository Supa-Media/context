/**
 * The chat picker's Made-up chats tab (artboard 01 of `group-chat-sim-artboards/`): Maya's 1:1 first, then the
 * ready-made group chats in two columns (a line on each, its size, a dot per person by account), then
 * "+ New group chat…" with the dots' legend. A scenario opens at once; its setup is one click further (Set up).
 * On a pull request's preview the people are made there, in its three seeded workspaces; on main they live only in the
 * test chat, with roles in the Lab user's own shared workspaces (`labSandbox/worldLocal.js`), and the scenarios use those.
 */
import type { SandboxSource } from "../../../engine/sandbox";
import { useEffect } from "react";
import { blankDraft, placedWords, SCENARIOS, scenarioDraft, scenarioNeeds, workspaces, type Account } from "./worldModel";
import { loadWorkspaces, openSetup, openWorld, useWorld } from "./worldStore";

const DT: Record<Account, string> = { on: "on", off: "off", invited: "inv" };

function Dots({ accounts }: { accounts: Account[] }) {
  return (
    <span className="dts" title="Who's in it">
      {accounts.map((a, i) => (
        <i key={i} className={"dt " + DT[a]} />
      ))}
    </span>
  );
}

export function WorldPick({ hit, cur, main, versionId, open, close }: { hit: (s: string) => boolean; cur: string; main: boolean; versionId: string; open: (s: SandboxSource) => void; close: () => void }) {
  const w = useWorld();
  useEffect(() => void loadWorkspaces(main), [main]);
  const shown = SCENARIOS.filter((s) => hit(s.title + " " + placedWords(s.says)));
  const none = main && w.workspacesFor === "main" && workspaces().length === 0;
  const have = workspaces().length;
  const lacks = (id: string) => main && w.workspacesFor === "main" && scenarioNeeds(id) > have;
  const cut = main && (w.workspacesTotal ?? 0) > have ? w.workspacesTotal : null;
  return (
    <>
      <div className="mh hx">
        Made-up chats <span>{main ? "Made-up people in your own shared workspaces: Tex reads your real notes there, and nothing it writes leaves the test chat." : "Made-up people and workspaces. Nothing touches real ones."}</span>
      </div>
      {none ? (
        <div className="mnote code" id="sbWorldMain">
          You&apos;re in no shared workspace, so made-up people here have no roles and nobody can be invited by number. Set Code to #&lt;PR&gt; for made-up workspaces.
        </div>
      ) : null}
      {main && w.workspacesProblem ? (
        <div className="mnote bad" id="sbWorldProblem">
          Couldn&apos;t read your workspaces: {w.workspacesProblem} ·{" "}
          <a onClick={() => void loadWorkspaces(true)}>Try again</a>
        </div>
      ) : null}
      {cut ? (
        <div className="mnote" id="sbWorldCut">
          Showing your first {have} of {cut} shared workspaces.
        </div>
      ) : null}
      <div className="pgrid" id="sbWorlds">
        {hit("Maya (test account) A 1:1 with Tex, on her own workspace") ? (
          <button className="mi two" data-chat="maya" aria-current={cur === "maya"} onClick={() => open({ kind: "maya" })}>
            <span className="tx">
              <span className="nm">Maya</span>
              <span className="ds">A 1:1 with Tex, on her own workspace</span>
            </span>
            <span className="side2">
              <span className="meta">1:1</span>
              <Dots accounts={["on"]} />
            </span>
          </button>
        ) : null}
        {shown.map((s) => (
          <button
            key={s.id}
            className="mi two"
            data-world={s.id}
            disabled={lacks(s.id)}
            title={lacks(s.id) ? `Needs ${scenarioNeeds(s.id)} shared workspaces; you have ${have}` : placedWords(s.says)}
            onClick={() => {
              // On the workspaces here: read first, so a scenario opened at once is placed on them; a failed read
              // keeps the picker open with its reason.
              void loadWorkspaces(main).then((ok) => {
                const d = ok ? scenarioDraft(s.id) : null;
                if (!d) return;
                close();
                void openWorld(d, versionId);
              });
            }}
          >
            <span className="tx">
              <span className="nm">{s.title}</span>
              <span className="ds">{placedWords(s.says)}</span>
            </span>
            <span className="side2">
              <span className="meta">{s.size}</span>
              <Dots accounts={s.draft.people.map((p) => p.account)} />
            </span>
          </button>
        ))}
      </div>
      <hr />
      <button
        className="mi newg"
        id="sbNewGroup"
        onClick={() => {
          void loadWorkspaces(main).then((ok) => {
            if (!ok) return;
            close();
            openSetup(blankDraft());
          });
        }}
      >
        <span className="plus">+</span>
        <span className="nm">New group chat…</span>
        <span className="meta">choose the people, their accounts and roles</span>
      </button>
      <div className="legend">
        <span>
          <i className="dt on" />
          On Context
        </span>
        <span>
          <i className="dt off" />
          Not on Context
        </span>
        <span>
          <i className="dt inv" />
          Invited by number
        </span>
      </div>
    </>
  );
}

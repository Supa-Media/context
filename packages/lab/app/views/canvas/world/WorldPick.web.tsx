/**
 * The chat picker's Made-up chats tab (artboard 01 of `group-chat-sim-artboards/`): Maya's 1:1 first, then the
 * ready-made group chats in two columns (a line on each, its size, a dot per person by account), then
 * "+ New group chat…" with the dots' legend. A scenario opens at once; its setup is one click further (Set up).
 * Made-up group chats run only on a pull request's preview, so on main the tab says so and opens none.
 */
import type { SandboxSource } from "../../../engine/sandbox";
import { blankDraft, SCENARIOS, scenarioDraft, type Account } from "./worldModel";
import { openSetup, openWorld } from "./worldStore";

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
  const shown = SCENARIOS.filter((s) => hit(s.title + " " + s.says));
  return (
    <>
      <div className="mh hx">
        Made-up chats <span>Made-up people and workspaces. Nothing touches real ones.</span>
      </div>
      {main ? (
        <div className="mnote code" id="sbWorldMain">
          Made-up group chats run on a pull request&apos;s preview: set Code to #&lt;PR&gt;.
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
            disabled={main}
            title={main ? "Set Code to a pull request first" : s.says}
            onClick={() => {
              close();
              const d = scenarioDraft(s.id);
              if (d) void openWorld(d, versionId);
            }}
          >
            <span className="tx">
              <span className="nm">{s.title}</span>
              <span className="ds">{s.says}</span>
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
          close();
          openSetup(blankDraft());
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

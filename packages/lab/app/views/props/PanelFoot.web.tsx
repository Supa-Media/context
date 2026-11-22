/**
 * The step card's foot, as the approved Lab live sandbox mockup has it: on Run details, where the step's log comes
 * from ("Logged step · <the version that ran> · tex_dev sandbox steps"), or that nothing was logged for this text; on
 * Settings, which draft the settings are in and that they save as they change.
 */
import { BASE_SHA } from "../../data/graph";
import { playingProd } from "../../engine/sandboxPlay";
import { isMain, lab } from "../../engine/state";

/** The version a run's steps come from: a real text's own commit, else the version open (a draft names its base). */
export function loggedFrom(): string {
  const prod = playingProd();
  if (prod) return prod.run.prod?.code ? `commit ${prod.run.prod.code}, as it ran in prod` : "the version that ran in prod";
  return isMain() ? `main@${BASE_SHA}` : `${lab.cur.name}, from main@${BASE_SHA}`;
}

export function PanelFoot({ card, ran }: { card: "run" | "set"; ran: boolean }) {
  return (
    <div className="insft" id="insFoot">
      {card === "set" ? (
        <>
          {isMain() ? "main: a change starts your own copy" : `Draft ${lab.cur.name} · saved as you change it`} · <code>tex_dev node set</code>
        </>
      ) : ran ? (
        <>
          Logged step · {loggedFrom()} · <code>tex_dev test_chat step</code>
        </>
      ) : (
        "Nothing logged for this text"
      )}
    </div>
  );
}

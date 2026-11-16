/**
 * The step card for the test chat's line (`engine/lineSteps.ts`): what the simulated line did for the text picked, in
 * the same Run details as any step, from its logged `lineIn` / `lineOut` step. The line is the sandbox's transport,
 * not a step of Tex, so it has no Settings card, no Focus and nothing to edit or delete.
 */
import type { ReactNode } from "react";
import { lineLabel, type LineStep } from "../../engine/lineSteps";
import type { LabNode } from "../../types";
import { Ic } from "../ic";
import { PanelFoot } from "./PanelFoot.web";
import { RunCard, StatusBadge, StatusRow, useStepRun } from "./RunCard.web";

export function LinePanel({ id, extra }: { id: LineStep; extra?: ReactNode }) {
  const n: LabNode = { id, label: lineLabel(id), goal: "", log: true, on: true, rounds: 1, out: 0, ctx: [], ms: 0, timeoutS: 0, areas: [], file: "", note: "", icon: "plug", model: "code", x: 0, y: 0 };
  const { has, run } = useStepRun(n);
  return (
    <>
      <div className="cardrow">
        <span className="bdg line" id="lineTag">
          Sandbox line
        </span>
      </div>
      <div className="ph">
        <span className="badge" style={{ color: "var(--dim)" }}>
          <Ic k="plug" />
        </span>
        <b className="lname" id="lineName">
          {n.label}
        </b>
        <StatusBadge run={run} />
        {extra}
      </div>
      <StatusRow n={n} card="run" run={run} draft="" />
      <p className="hint lnote">{id === "lineIn" ? "The test chat holds each text on its simulated line before Tex gets it, as a phone line would." : "Each of Tex's texts is held on the simulated line before it shows as delivered."} Not a step of Tex: never in a draft.</p>
      <RunCard n={n} has={has} run={run} />
      <PanelFoot card="run" ran={run.state !== "none"} />
    </>
  );
}

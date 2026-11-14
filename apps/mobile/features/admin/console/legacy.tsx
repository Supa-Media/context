/**
 * The old console's sections, drawn in the new console's page slot until each page is ported from
 * the artifact (a page drops its `Legacy` when it gains `render`). Kept in one file so deleting it
 * is the last step of the port: when no page names it, nothing imports this.
 */
import { useState } from "react";
import { AgentSection } from "../AgentSection";
import { AiCostsSection } from "../AiCostsSection";
import { S } from "./state";

const days = () => Number(S.d) || 30;

export function LegacyTurns() {
  const [open, setOpen] = useState<string | null>(null);
  return <AgentSection openId={open} onOpen={setOpen} />;
}
export function LegacyCosts() {
  const [open, setOpen] = useState<string | null>(null);
  return <AiCostsSection days={days()} openId={open} onOpen={setOpen} />;
}

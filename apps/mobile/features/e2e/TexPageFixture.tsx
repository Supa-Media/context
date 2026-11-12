import { useMemo, useState } from "react";
import { Screen } from "../app/Screen";
import { TexPageBody, type Place } from "../tex/page/TexPageBody";
import { fixtureNow, fixtureSource } from "../tex/page/texPageFixture";
import { readPlace } from "../tex/page/texPlace";
import { MACHINE_SCENARIOS, machineFixtureSource, type MachineScenario } from "../tex/page/texMachineFixture";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
import { useTexPage } from "../tex/page/useTexPage";
import type { TexComputerState } from "../tex/useTexComputer";
import { FIXTURE_FRAME } from "./texComputerFrame";
import { TexComputerBody } from "../tex/TexComputerScreen";

/** Tex's browser, live on a made-up docs page, so the job page and the computer page draw as the mock does. */
const COMPUTER: TexComputerState = {
  phase: "live",
  frame: { running: true, url: "https://maritime.sh/docs/agents", title: "Maritime · Agents", width: 640, height: 400, scale: 1, frame: FIXTURE_FRAME },
  busy: false,
  send: () => {},
  stop: () => {},
};

/**
 * `/e2e-fixture?screen=tex-page`: the Tex page on the mock's example data, for
 * the screenshot passes against Dev2's approved mock and the browser tests.
 * `chat`, `view` and `job` start it where the real address would. Moving
 * around stays in this screen; actions change the in-memory copy and arrive
 * back over its live feed, as the gateway's do.
 */
export function TexPageFixture({ params }: { params: Record<string, string | string[] | undefined> }) {
  // `machines=<scenario>` draws the machine screens' data (`texMachineFixture.ts`); `ask=1` adds a job waiting for a yes.
  const scenario = first(params.machines);
  const ask = first(params.ask) === "1";
  const source = useMemo(
    () => (scenario && (MACHINE_SCENARIOS as readonly string[]).includes(scenario) ? machineFixtureSource(scenario as MachineScenario, { ask }) : fixtureSource()),
    [scenario, ask],
  );
  const [place, setPlace] = useState<Place>(() => readPlace(params));
  const page = useTexPage(source, place.chat);
  // `full=1`: the take-over screen a handoff's "Take over" opens, as `TexPageScreen` draws it.
  if (place.view === "computer" && place.full) return <TexComputerBody view={{ kind: "ready", handle: "fixture", workspaceId: "ws_fixture" }} computer={COMPUTER} />;
  return (
    <Screen testID="tex-page-fixture">
      <TexPageBody
        source={source}
        page={page}
        place={place}
        go={setPlace}
        computer={COMPUTER}
        openComputer={() => setPlace({ chat: place.chat, view: "computer", full: true })}
        now={fixtureNow}
      />
    </Screen>
  );
}

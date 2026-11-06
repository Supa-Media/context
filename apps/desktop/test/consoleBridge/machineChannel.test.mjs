/**
 * "Let Tex use this Mac" (bridge version 10) as the main process answers it:
 * only to the console's own frame, and with a status rebuilt field by field,
 * so nothing the runner or a bug put on the object (a grant, a path) reaches
 * the page. Split from `ipcCensus.test.mjs`, which counts the channels.
 */

import { BRIDGE_CHANNELS } from "@context/desktop-bridge";
import { mainBridge, sender } from "./fixtures.mjs";

export async function runMachineChannelChecks(check) {
  const switched = [];
  const leaky = { available: true, enabled: true, state: "online", slots: 2, busy: 1, awake: true, message: null, grant: "machine-grant-secret", grantFile: "/Users/x/grant" };
  const deps = {
    machine: () => leaky,
    setMachineEnabled: async (on) => (switched.push(on), { ...leaky, enabled: on }),
  };
  const { ipc } = mainBridge({ deps });
  const status = (await ipc.handlers.get(BRIDGE_CHANNELS.machineStatus)(sender())).value;
  check("the console can read whether this Mac runs Tex's jobs", status.state === "online" && status.slots === 2 && status.awake === true);
  check("...and nothing but the status's own fields crosses: no grant, no path", !JSON.stringify(status).includes("grant") && !JSON.stringify(status).includes("/Users"));
  const after = (await ipc.handlers.get(BRIDGE_CHANNELS.machineSetEnabled)(sender(), { enabled: "true" })).value;
  check("only a real true turns it on: a string is off", switched[0] === false && after.enabled === false);
  await ipc.handlers.get(BRIDGE_CHANNELS.machineSetEnabled)(sender(), { enabled: true });
  check("...and true turns it on", switched[1] === true);

  let refused = false;
  const { ipc: other } = mainBridge({ deps });
  try {
    const answer = await other.handlers.get(BRIDGE_CHANNELS.machineSetEnabled)(sender({ id: 99 }), { enabled: true });
    refused = answer?.ok === false;
  } catch {
    refused = true;
  }
  check("a frame that is not the console cannot turn on Let Tex use this Mac", refused && switched.length === 2);

  const { ipc: bare } = mainBridge({ deps: { machine: undefined, setMachineEnabled: undefined } });
  const off = (await bare.handlers.get(BRIDGE_CHANNELS.machineStatus)(sender())).value;
  check("a shell wired without a runner answers off, not an error", off.state === "off" && off.available === false);

  // Version 12: this Mac's id and the folder picker; the page saves with its own grant.
  const picks = [];
  const { ipc: folders } = mainBridge({
    deps: {
      machineId: async () => "mch_01abc",
      pickMachineFolders: async () => (picks.push(true), ["/Users/a/Code/context", "relative", "/Users/a/Code/context"]),
    },
  });
  const id = (await folders.handlers.get(BRIDGE_CHANNELS.machineId)(sender())).value;
  check("the console reads this Mac's id, in the gateway's shape", id === "mch_01abc");
  const chosen = (await folders.handlers.get(BRIDGE_CHANNELS.machinePickFolders)(sender())).value;
  check("...and opens the picker, answering the folders chosen, rebuilt: absolute paths, each once", picks.length === 1 && JSON.stringify(chosen) === JSON.stringify(["/Users/a/Code/context"]));
  let pickRefused = false;
  try {
    const answer = await folders.handlers.get(BRIDGE_CHANNELS.machinePickFolders)(sender({ id: 99 }));
    pickRefused = answer?.ok === false;
  } catch {
    pickRefused = true;
  }
  check("...and a frame that is not the console cannot open the folder picker", pickRefused && picks.length === 1);
  const { ipc: odd } = mainBridge({ deps: { machineId: async () => "cmg_" + "0".repeat(64) + "/x" } });
  check("...and anything not shaped like an id never reaches the page", (await odd.handlers.get(BRIDGE_CHANNELS.machineId)(sender())).value === null);
  const unknown = (await bare.handlers.get(BRIDGE_CHANNELS.machinePickFolders)(sender())).value;
  check("...and a shell wired without a picker answers null (Cancel), not an empty list", unknown === null);
}

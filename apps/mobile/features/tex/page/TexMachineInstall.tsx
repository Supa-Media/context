import { StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { Machine, MachineInstall, ToolName } from "./texMachineTypes";

/** As long as an install may run (`INSTALL_WAIT_MS` in the gateway's `serveMachines.js`). */
export const INSTALL_FRESH_MS = 21 * 60 * 1000;

/** The install to draw for a tool now: the computer's latest one for it, while it is still worth showing. */
export function installFor(m: Pick<Machine, "install">, tool: ToolName, now: number): MachineInstall | null {
  const i = m.install;
  if (!i || i.tool !== tool || now - i.at > INSTALL_FRESH_MS) return null;
  return i;
}

/** Whether the computer is still installing, so the page reads it again soon. */
export function installBusy(m: Pick<Machine, "install">, now: number): boolean {
  const i = m.install;
  return !!i && (i.state === "starting" || i.state === "working") && now - i.at < INSTALL_FRESH_MS;
}

/** The tool row's line while an install runs or after it failed. */
export function installLine(i: MachineInstall, here: string): string {
  if (i.state === "failed") return i.error ? `Didn't install: ${i.error}` : "Didn't install. Try again.";
  if (i.state === "done") return i.version ? `Installed ${i.version}` : "Installed";
  if (i.state === "starting") return `Asking ${here} to install it…`;
  switch (i.step) {
    case "downloading":
      return `Downloading on ${here}…${i.percent !== undefined ? ` ${i.percent}%` : ""}`;
    case "checking":
      return "Checking the download…";
    case "unpacking":
      return "Putting it in place…";
    default:
      return "Finding the latest version…";
  }
}

/** How far the download has got, under the tool's row. */
export function InstallBar({ percent }: { percent: number | undefined }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.track} testID="tex-machine-install-bar">
      <View style={[styles.fill, { width: `${Math.max(4, Math.min(100, percent ?? 4))}%` }]} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    track: { height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden", marginBottom: 12 },
    fill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  });

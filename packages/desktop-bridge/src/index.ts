/**
 * `@context/desktop-bridge` — the surface between the one UI and the shell.
 *
 * One import for `apps/mobile` (which asks) and for `apps/desktop` (which
 * answers). `apps/mcp` imports none of it, and that is a check rather than a
 * sentence: `scripts/check-gateway-imports.mjs` refuses any specifier naming
 * this package from the gateway's tree, self-tested, run by `mcp.yml` on every
 * pull request. The gateway is a dependency-free Workers bundle that writes
 * meetings into a customer's bucket; an Electron-shaped IPC contract has no
 * business in its dependency graph.
 *
 * See `src/contract.ts` for the shape and `src/bridge.ts` for the one function
 * that reaches for `window.desktop`.
 */

export {
  BRIDGE_CHANNEL_NAMES,
  BRIDGE_CHANNELS,
  BRIDGE_VERSION,
  CAPABILITY_NAMES,
  MIN_BRIDGE_VERSION,
  NO_CAPABILITIES,
  TRAY_COMMANDS,
  capabilitiesFrom,
} from "./contract.ts";

export type {
  AudioLevel,
  CaptureFault,
  CaptureStarted,
  CaptureState,
  CaptureStateUpdate,
  CaptureSummary,
  ConnectionView,
  DesktopBridge,
  DesktopCapabilities,
  DesktopPlatform,
  DesktopShell,
  DetectionView,
  OutboxStatus,
  StartCaptureRequest,
  TranscribesAt,
  TranscriptSegment,
  TrayCommand,
  Unsubscribe,
} from "./contract.ts";

export {
  getDesktopBridge,
  inspectDesktopBridge,
  isSupportedBridgeVersion,
} from "./bridge.ts";

export type { BridgeRefusal, BridgeScope } from "./bridge.ts";

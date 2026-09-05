/**
 * The macOS collectors, as one `SignalCollectors`.
 *
 * macOS first, deliberately: it is where ScreenCaptureKit makes bot-free system
 * audio capture possible at all, and the folder name is the whole porting plan.
 * `platform/windows/` and `platform/linux/` implement the same four functions
 * and nothing above this line changes.
 */

import type { SignalCollectors } from "../../core/detection/collectors.ts";
import { collectProcesses } from "./processes.ts";
import { collectWindows } from "./windows.ts";
import { collectMicrophoneInUse } from "./microphone.ts";
import { collectCalendarEvents } from "./calendar.ts";

export function macosCollectors(): SignalCollectors {
  return {
    processes: collectProcesses,
    windows: collectWindows,
    microphoneInUse: collectMicrophoneInUse,
    calendarEvents: collectCalendarEvents,
  };
}

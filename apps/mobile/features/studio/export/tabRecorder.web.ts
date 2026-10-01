import { cropFor, pickVideoType, pictureLag } from "./videoExport";
import type { CaptureRequest, TabCapture } from "./tabRecorder";

const FPS = 30;
/** Plenty for 1080p screen content, which is mostly flat colour and text. */
const BITS_PER_SECOND = 8_000_000;
/** The timing square: a corner of the page, in CSS pixels, and how often it flips. */
const MARK_PX = 8;
const MARK_FLIP_MS = 200;
/** A flip not seen by then is given up on rather than read late. */
const MARK_GIVE_UP_MS = 1_000;

/**
 * Share this tab, cut the stage out of it, and record that with the scene's
 * sounds (`videoExport.ts` says why each piece is the way it is).
 *
 * `getDisplayMedia` is the first thing called, with nothing awaited before
 * it, because a browser asks only from inside the press that wanted it.
 */
export async function captureTab({ stage, size, sound, lagSound, onStopped }: CaptureRequest): Promise<TabCapture> {
  const type = pickVideoType((mime) => MediaRecorder.isTypeSupported(mime));
  if (type === null) return { problem: "This browser can’t record video. Try Chrome or Edge." };
  let shared: MediaStream;
  try {
    shared = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: FPS },
      audio: false,
      // Chrome's: offer this tab first and nothing else worth choosing.
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    } as DisplayMediaStreamOptions);
  } catch {
    return { problem: "Export needs this tab shared. Press Export video again and choose this tab." };
  }
  const track = shared.getVideoTracks()[0];
  const surface = (track?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  if (track === undefined || (surface !== undefined && surface !== "browser")) {
    for (const one of shared.getTracks()) one.stop();
    return { problem: "Choose this tab when the browser asks, not a window or a screen." };
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = shared;
  await video.play().catch(() => {});

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const paint = canvas.getContext("2d");
  const timing = timePicture(video);
  let frame = 0;
  const draw = () => {
    const box = stage()?.getBoundingClientRect();
    if (paint !== null && box !== undefined) {
      const crop = cropFor(box, { width: window.innerWidth, height: window.innerHeight }, { width: video.videoWidth, height: video.videoHeight });
      if (crop.width > 0 && crop.height > 0) paint.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
    }
    // In the same frame as the drawing, so it times the trip the take makes.
    timing.look();
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);

  const out = canvas.captureStream(FPS);
  for (const one of sound?.getAudioTracks() ?? []) out.addTrack(one);
  const recorder = new MediaRecorder(out, { mimeType: type.mimeType, videoBitsPerSecond: BITS_PER_SECOND });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  let over = false;
  const stopAll = () => {
    over = true;
    timing.stop();
    cancelAnimationFrame(frame);
    for (const one of shared.getTracks()) one.stop();
    for (const one of out.getVideoTracks()) one.stop();
    video.srcObject = null;
  };
  track.addEventListener("ended", () => {
    if (over) return;
    if (recorder.state !== "inactive") recorder.stop();
    stopAll();
    onStopped();
  });

  return {
    type,
    begin: () => {
      // The countdown was the timing; the square goes before anything is kept.
      lagSound?.(pictureLag(timing.stop()) / 1_000);
      recorder.start(1_000);
    },
    finish: () =>
      new Promise<Blob>((resolve) => {
        const done = () => {
          stopAll();
          resolve(new Blob(chunks, { type: type.mimeType.split(";")[0] }));
        };
        if (recorder.state === "inactive") return done();
        recorder.onstop = done;
        recorder.stop();
      }),
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      stopAll();
    },
  };
}

/**
 * How long the shared tab takes to show what the page drew, timed during the
 * countdown, before the take starts (`pictureLag` says why it matters).
 *
 * A small square in the page's corner flips between black and white; each
 * time the shared picture shows the flip, the wait is one reading. The
 * square is gone before anything is recorded, so it is never in the file.
 */
function timePicture(video: HTMLVideoElement): { look: () => void; stop: () => number[] } {
  const readings: number[] = [];
  const mark = document.createElement("div");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("data-export-timing", "");
  Object.assign(mark.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${MARK_PX}px`,
    height: `${MARK_PX}px`,
    background: "#000",
    zIndex: "2147483647",
    pointerEvents: "none",
  });
  document.body.appendChild(mark);
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  let white = false;
  let flipped: number | null = null;
  let last = performance.now();
  let stopped = false;
  return {
    look() {
      if (stopped || probe === null || video.videoWidth === 0 || window.innerWidth === 0) return;
      const now = performance.now();
      if (flipped !== null) {
        const x = (MARK_PX / 2) * (video.videoWidth / window.innerWidth);
        const y = (MARK_PX / 2) * (video.videoHeight / window.innerHeight);
        probe.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
        if (probe.getImageData(0, 0, 1, 1).data[0] > 127 === white) {
          readings.push(now - flipped);
          flipped = null;
          last = now;
        } else if (now - flipped > MARK_GIVE_UP_MS) {
          flipped = null;
          last = now;
        }
        return;
      }
      if (now - last < MARK_FLIP_MS) return;
      white = !white;
      mark.style.background = white ? "#fff" : "#000";
      flipped = now;
    },
    stop() {
      stopped = true;
      mark.remove();
      return readings;
    },
  };
}

/** Hand the take to the browser to keep (`saveFile.web.ts`'s pattern, for a Blob). */
export function saveVideo(name: string, video: Blob): void {
  const url = URL.createObjectURL(video);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

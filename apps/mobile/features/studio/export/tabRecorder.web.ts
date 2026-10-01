import { cropFor, pickVideoType } from "./videoExport";
import type { CaptureRequest, TabCapture } from "./tabRecorder";

const FPS = 30;
/** Plenty for 1080p screen content, which is mostly flat colour and text. */
const BITS_PER_SECOND = 8_000_000;

/**
 * Share this tab, cut the stage out of it, and record that with the scene's
 * sounds (`videoExport.ts` says why each piece is the way it is).
 *
 * `getDisplayMedia` is the first thing called, with nothing awaited before
 * it, because a browser asks only from inside the press that wanted it.
 */
export async function captureTab({ stage, size, sound, onStopped }: CaptureRequest): Promise<TabCapture> {
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
  let frame = 0;
  const draw = () => {
    const box = stage()?.getBoundingClientRect();
    if (paint !== null && box !== undefined) {
      const crop = cropFor(box, { width: window.innerWidth, height: window.innerHeight }, { width: video.videoWidth, height: video.videoHeight });
      if (crop.width > 0 && crop.height > 0) paint.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
    }
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
    begin: () => recorder.start(1_000),
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

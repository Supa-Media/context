/**
 * Screenshots on iOS and Android: not yet.
 *
 * Capturing the app's own view needs a native module (react-native-view-shot)
 * this build does not carry, so the report on the phone apps sends without a
 * picture and its screenshot row is not drawn. It arrives with the next native
 * build, together with shake-to-report. The web half is `screenshot.web.ts`.
 */

export interface Screenshot {
  data: Uint8Array;
  contentType: string;
  /** A data: URI for the preview on the report screen. */
  previewUri: string;
  width: number;
  height: number;
}

export const screenshotSupported = false;

export async function captureScreen(_options: { showText: boolean }): Promise<Screenshot | null> {
  return null;
}

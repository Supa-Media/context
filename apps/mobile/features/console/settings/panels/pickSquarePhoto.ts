import { WORKSPACE_ICON_MAX_BYTES } from "@context/shared";
import { bytesFromBase64 } from "../../files/imageBytes";

export type PickedPhoto =
  | { kind: "picked"; bytes: ArrayBuffer; contentType: string }
  | { kind: "canceled" }
  | { kind: "error"; message: string };

/**
 * Let somebody choose a photo, cropped square and compressed on the device.
 *
 * Shared by the workspace icon picker and "Your picture", which take the same
 * kind of image under the same cap.
 */
export async function pickSquarePhoto(): Promise<PickedPhoto> {
  /*
    LOADED WHEN SOMEBODY PICKS A PHOTO, NOT WHEN THE CONSOLE BOOTS.

    A static import would put a native module in the import graph of
    `OverviewPanel`, and so of `SettingsPane`, and so of the console's layout
    — which `jest.config.js` is deliberately built to keep out: it has no
    `jest-expo` preset and no native mocks, on the stated grounds that the
    modules under test are free of native imports. A static import here cost
    25 suites a syntax error inside `expo-modules-core`, and the fix for that
    would have been to widen the transform allow-list and start defining React
    Native globals in the setup file — which is the preset that file says it
    does not want, arrived at one package at a time.

    The app gets the better half of the deal anyway: the picker is code
    nobody loads until they choose a photo.
  */
  const ImagePicker = await import("expo-image-picker");
  /*
    SQUARE, AND COMPRESSED, BEFORE IT EVER LEAVES THE DEVICE.

    `allowsEditing` with a 1:1 `aspect` is the crop, and it matters for more
    than tidiness: the mark is a square and `contentFit="cover"` would
    otherwise choose the centre of a portrait photo, which is a person's chest.
    Letting them frame it is the difference between an avatar and a crop.

    `quality` is the other half. This app has no image resizer —
    `expo-image-manipulator` is not a dependency and adding one would mean a
    native module and a new development build for every contributor — so the
    compression the picker itself applies is what keeps a 12-megapixel photo
    under the cap. It is enough for a square crop in every ordinary case, and
    the case it is not is answered honestly below rather than silently.
  */
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.7,
    /*
      THE BYTES COME BACK WITH THE PICK, RATHER THAN BEING FETCHED AFTER IT.

      The obvious next line is `fetch(asset.uri)` and it is a web habit: on
      native the uri is a `file://` path, and `Response.arrayBuffer` over one
      is exactly the sort of thing that works in Expo Go, works on one
      platform, and returns an empty buffer on the other. `base64` is produced
      by the picker itself on both, so there is one path and no filesystem.

      `bytesFromBase64` is the app's own decoder, written out rather than
      leaning on `atob` for the reason its header gives — and reused rather
      than rewritten, so there is one base64 implementation for images.
    */
    base64: true,
  });
  if (result.canceled) return { kind: "canceled" };
  const asset = result.assets[0];
  if (asset === undefined) return { kind: "canceled" };
  if (asset.base64 === undefined || asset.base64 === null) {
    return { kind: "error", message: "That photo could not be read. Try another one." };
  }
  const bytes = bytesFromBase64(asset.base64);
  if (bytes.byteLength > WORKSPACE_ICON_MAX_BYTES) {
    /*
      Checked here as well as on the server, and this is the one place a
      duplicated limit earns its keep: the alternative is uploading a
      megabyte and a half to be told no. The number and the rule are
      imported rather than retyped, so there is one of each.
    */
    return { kind: "error", message: "That photo is too large even cropped. Try a smaller one." };
  }
  /*
    The picker hands back JPEG on both platforms for a compressed crop —
    including from an iPhone's HEIC original, which is why HEIC is not in
    the accepted set at all. `mimeType` is trusted only as far as the
    server's own allow-list, which refuses anything else by name.
  */
  return { kind: "picked", bytes, contentType: asset.mimeType ?? "image/jpeg" };
}

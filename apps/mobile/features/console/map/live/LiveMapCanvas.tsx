import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Text } from "../../../design/components/Text";
import { faceFor as storedFace, type ShownFace } from "../../faces/faceStore";
import { NAVIGATION_ORIGINS, allowInitialLoadOnly, editorDocument } from "../../files/webview/host/document";
import type { LiveMapCanvasProps } from "./LiveMapCanvas.web";
import { MAP_BUNDLE } from "./webview/bundle.generated";
import { createMapHost, peopleIn } from "./webview/host";

/**
 * The live map in the phone app: the web build's own engine, running in a
 * `WebView` (`webview/entry.ts`, compiled into `webview/bundle.generated.ts`),
 * because React Native has no `<canvas>` and drawing the map twice would let
 * the two drift. The page around it cannot tell: it gets the same callbacks
 * and an engine object whose calls cross the bridge (`webview/host.ts`).
 *
 * The document is the editor's shell, with its Content-Security-Policy of
 * `default-src 'none'`: the map's code is in the app, and the web view can
 * reach no network at all. That is also why a person's photo is handed over
 * as a data URI (`usePhotoFaces`) rather than as its address.
 */
export type { LiveMapCanvasProps };

const SOURCE = { html: editorDocument(MAP_BUNDLE) };

export function LiveMapCanvas(props: LiveMapCanvasProps) {
  const web = useRef<WebView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [failed, setFailed] = useState<string | null>(null);

  const host = useMemo(
    () =>
      createMapHost(
        (raw) => web.current?.postMessage(raw),
        () => ({
          onCamera: propsRef.current.onCamera,
          onFollow: propsRef.current.onFollow,
          onHover: propsRef.current.onHover,
          onOpenNote: propsRef.current.onOpenNote,
          onDiveInto: propsRef.current.onDiveInto,
          onTime: propsRef.current.onTime,
          onFailed: (message) => setFailed(message),
        }),
      ),
    [],
  );

  useEffect(() => {
    propsRef.current.onEngine?.(host.engine);
    return () => propsRef.current.onEngine?.(null);
  }, [host]);

  const { data, inset, reducedMotion, playing, following, minimap } = props;
  useEffect(() => {
    host.setData(data);
  }, [host, data]);
  useEffect(() => {
    host.setProps({ inset: inset ?? null, reducedMotion: !!reducedMotion, playing: !!playing, following, minimap });
  }, [host, inset, reducedMotion, playing, following, minimap]);

  const people = peopleIn(data).join("\n");
  const faces = usePhotoFaces(people);
  useEffect(() => {
    host.setFaces(faces);
  }, [host, faces]);

  if (failed !== null) {
    return (
      <View style={styles.failed} testID="map-webview-failed">
        <Text variant="meta">The map could not be drawn here ({failed}). Reopen the map to try again.</Text>
      </View>
    );
  }
  return (
    <View style={styles.fill}>
      <WebView
        ref={web}
        source={SOURCE}
        // `["*"]` sends every navigation to the handler that refuses it; a
        // narrower list would hand it to the system browser instead. See
        // `NAVIGATION_ORIGINS`.
        originWhitelist={NAVIGATION_ORIGINS as string[]}
        onShouldStartLoadWithRequest={allowInitialLoadOnly}
        onMessage={(event: WebViewMessageEvent) => host.receive(event.nativeEvent.data)}
        onError={() => setFailed("the web view failed to load")}
        onContentProcessDidTerminate={() => web.current?.reload()}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        style={styles.web}
        containerStyle={styles.web}
        javaScriptEnabled
        testID="map-webview"
      />
    </View>
  );
}

/**
 * The faces of the people on the map, with each photo read into a data URI
 * once, so the web view needs no network to show it. A photo that cannot be
 * read is left out, and the guest draws that person's default face.
 */
function usePhotoFaces(people: string): Record<string, ShownFace> {
  const [faces, setFaces] = useState<Record<string, ShownFace>>({});
  const read = useRef(new Map<string, string | null>());
  useEffect(() => {
    let stopped = false;
    const names = people === "" ? [] : people.split("\n");
    const build = () => {
      const next: Record<string, ShownFace> = {};
      for (const name of names) {
        const face = storedFace(name);
        if (face?.kind === "emoji") next[name] = face;
        else if (face?.kind === "photo") {
          const uri = read.current.get(face.uri);
          if (uri) next[name] = { kind: "photo", uri };
        }
      }
      return next;
    };
    setFaces(build());
    for (const name of names) {
      const face = storedFace(name);
      if (face?.kind !== "photo" || read.current.has(face.uri)) continue;
      read.current.set(face.uri, null);
      void dataUriOf(face.uri).then((uri) => {
        read.current.set(face.uri, uri);
        if (!stopped && uri !== null) setFaces(build());
      });
    }
    return () => {
      stopped = true;
    };
  }, [people]);
  return faces;
}

async function dataUriOf(uri: string): Promise<string | null> {
  if (uri.startsWith("data:")) return uri;
  try {
    const response = await fetch(uri);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.size > 2_000_000) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },
  failed: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
});

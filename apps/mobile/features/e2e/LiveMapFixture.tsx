import { useMemo, useState } from "react";
import { MapRouteProvider } from "../console/map/live/MapRouteContext";
import { MapSourceProvider } from "../console/map/live/MapSourceContext";
import type { MapRoute } from "../console/map/live/route";
import { AppFrameVisualFixture } from "./AppFrameVisualFixture";
import { liveMapFixture } from "./liveMapFixtureData";

/**
 * The live map, open over Browse, on invented data — for looking at.
 *
 * The real `MapPage` inside the real console frame (`AppFrameVisualFixture`),
 * with the two things the product supplies from elsewhere supplied here: the
 * map's route, open (`?map=1` in the product), and its data, from
 * `liveMapFixtureData.ts` rather than the control plane and the gateway.
 * Nothing here reaches an account, a bucket or a network.
 *
 * `/e2e-fixture?screen=live-map`, under the same `EXPO_PUBLIC_E2E_FIXTURE`
 * gate as everything else in this folder. The screenshot harness is
 * `scripts/capture-live-map-shots.mjs`, which presses Today, follows an AI
 * tool and switches scope by pressing the page's own controls.
 */
export function LiveMapFixture() {
  const [now] = useState(() => Date.now());
  const source = useMemo(() => liveMapFixture(now), [now]);
  const [open, setOpen] = useState(true);
  const route: MapRoute = useMemo(
    () => ({
      open,
      openMap: () => setOpen(true),
      closeMap: () => setOpen(false),
      toggle: () => setOpen((o) => !o),
      openNoteIn: () => {},
    }),
    [open],
  );
  return (
    <MapSourceProvider value={source}>
      <MapRouteProvider value={route}>
        <AppFrameVisualFixture />
      </MapRouteProvider>
    </MapSourceProvider>
  );
}

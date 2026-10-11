import { View } from "react-native";
import { Navigator } from "expo-router";
import { useColors } from "../../../features/design";
import { PlaceRouter } from "../../../features/admin/placeRouter";

/**
 * The staff console's navigator.
 *
 * One screen with a Back history of places rather than a `Stack`: every tab
 * and view is an address (`features/admin/place.ts`), and `PlaceRouter` is
 * what makes moving between them a browser Back step without mounting a
 * second console behind the first. See its header.
 *
 * The session gate is `(app)`'s and is not repeated; the *staff* gate is not
 * here either, and deliberately — it lives in `requireAdmin` on the server,
 * where a client cannot route around it. A layout that redirected non-staff
 * away would look like the authorization and would not be one.
 */
export default function AdminLayout() {
  const colors = useColors();
  return (
    <Navigator router={PlaceRouter}>
      <View style={{ flex: 1, backgroundColor: colors.ground }}>
        <Navigator.Slot />
      </View>
    </Navigator>
  );
}

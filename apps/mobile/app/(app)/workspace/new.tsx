import { CreateWorkspaceScreen } from "../../../features/workspace/CreateWorkspaceScreen";

/**
 * `/workspace/new` — making a shared context.
 *
 * Under `(app)` for `/welcome`'s reason: it needs a session, and the group's
 * gate sends a signed-out visitor to `/login` rather than a second copy of that
 * rule here. Deliberately not under `console/`, whose layout owns the rail, the
 * context switcher and the storage subscriptions — all of which are about
 * contexts that already exist.
 *
 * Unlike `/welcome` there is no gate on the screen itself: a person may own
 * several workspaces, so the only limits are the control plane's own and they
 * arrive as refusals from `createWorkspace`. See `CreateWorkspaceScreen`.
 */
export default function NewWorkspaceRoute() {
  return <CreateWorkspaceScreen />;
}

/**
 * Tex's basics on the staff console's front page, context.lc/admin (Dev2, 2026-11-11: "this should live on the
 * context.lc/admin page"): the same card as at the top of tex.lc/admin (`../tex/dashboard/DashboardBasics.web`), above
 * Growth. Its stylesheet goes into the document's head once, scoped under `.td-embed`, so the console's own text is
 * all the page's text. The console is staff only, and the action checks again.
 */

import { useEffect } from "react";
import { BasicsPanel } from "../tex/dashboard/DashboardBasics.web";
import { DASHBOARD_CSS } from "../tex/dashboard/dashboardCss";

const STYLE_ID = "tex-dashboard-css";

export function TexBasics() {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = DASHBOARD_CSS;
    document.head.appendChild(style);
  }, []);
  return (
    <div className="td-embed" data-testid="admin-tex-basics">
      <BasicsPanel enabled />
    </div>
  );
}

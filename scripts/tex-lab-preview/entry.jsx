import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "../../apps/mobile/features/tex/lab/TexLab.web";
createRoot(document.getElementById("root")).render(createElement(TexLab));

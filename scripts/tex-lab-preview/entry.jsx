import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "../../packages/lab/app/TexLab.web";
createRoot(document.getElementById("root")).render(createElement(TexLab));

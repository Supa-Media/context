/**
 * The Testing tab's columns scroll inside the window (Dev2, 2026-11-16: "the left column can't even scroll").
 *
 * `.tst` is `height:100%` inside the Lab's `.body` grid. Without a bounded row there, the row grows to its content,
 * so every panel is as tall as its list and nothing scrolls. Sabotage: drop `grid-template-rows` from
 * `.tl .body.testing` and this fails.
 */
import { LAB_CSS_3 } from "../features/tex/lab/labCss3";

test("the Testing body gives its one row the window's height, so the sets list scrolls", () => {
  const rule = /\.tl \.body\.testing\{([^}]*)\}/.exec(LAB_CSS_3)?.[1] ?? "";
  expect(rule).toMatch(/grid-template-rows:minmax\(0,1fr\)/);
  expect(LAB_CSS_3).toMatch(/\.tl \.tst \.scroll\{overflow:auto;min-height:0;flex:1\}/);
});

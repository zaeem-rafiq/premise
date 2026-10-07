// Component styles under the Floor's own policy (01-core SE14a). `style-src` falls back to
// `default-src 'self'`, so the page refuses an inline <style> element. A constructed style sheet is
// not an inline style: a component's CSS text is adopted once into `document.adoptedStyleSheets`.
// Components that cannot import a .css file (their wiring module must stay importable in the Node
// test program) use this instead; it does nothing where there is no document.

const adopted = new Set<string>();

/** Adopts `css` into the page's style sheets, once per distinct text. */
export function adoptCss(css: string): void {
  if (typeof document === "undefined" || adopted.has(css)) return;
  adopted.add(css);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function isIosStandalone(win) {
  const navigator = win.navigator || {};
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
    (/^Mac/i.test(navigator.platform || "") && navigator.maxTouchPoints > 1);
  return ios && (navigator.standalone === true || win.matchMedia?.("(display-mode: standalone)").matches === true);
}

export function syncVisualViewport(win = window) {
  const viewport = win.visualViewport;
  // Keep the last valid geometry while an inactive web view reports zero sizes.
  if (!viewport || !Number.isFinite(viewport.height) || viewport.height <= 0 || !Number.isFinite(viewport.offsetTop)) return;
  const root = win.document.documentElement;
  const layoutHeight = Math.max(root.clientHeight, win.innerHeight);
  const values = {
    height: viewport.height,
    bottom: Math.max(0, layoutHeight - viewport.height - viewport.offsetTop),
    "offset-top": viewport.offsetTop
  };
  for (const [name, value] of Object.entries(values)) {
    const property = `--visual-viewport-${name}`;
    const pixels = `${value}px`;
    if (root.style.getPropertyValue(property) !== pixels) root.style.setProperty(property, pixels);
  }
  // iOS home-screen apps can retain a taller layout viewport after rotation.
  // The shell needs both the visual height and its offset, in the same event.
  root.classList.toggle("ios-standalone-viewport", isIosStandalone(win));
}

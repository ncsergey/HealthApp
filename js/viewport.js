function isIosStandalone(win) {
  const navigator = win.navigator || {};
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
    (/^Mac/i.test(navigator.platform || "") && navigator.maxTouchPoints > 1);
  return ios && (navigator.standalone === true || win.matchMedia?.("(display-mode: standalone)").matches === true);
}

export function bindPanelDragGuard(win = window) {
  if (!isIosStandalone(win)) return;
  const preventDrag = (event) => {
    if (event.cancelable) event.preventDefault();
  };
  // Touchmove remains targeted at the element where the gesture began.
  // Cancel only moves originating on the panels; taps and content scrolling
  // keep their native handling. The listener backs up touch-action in iOS.
  for (const selector of [".app-header", ".bottom-nav"]) {
    win.document.querySelector(selector)?.addEventListener("touchmove", preventDrag, { passive: false });
  }
}

export function bindDialogDragGuard(win = window) {
  if (!isIosStandalone(win)) return;
  for (const dialog of win.document.querySelectorAll("dialog")) {
    dialog.addEventListener("touchmove", (event) => {
      if (!dialog.open) return;
      const content = event.target?.closest?.(".entry-form-content, .dialog-scroll-content");
      if (content && dialog.contains(content)) return;
      // Backdrop touches target the dialog itself, outside .app-main's guard.
      // Cancel the first move there and on the fixed parts of the dialog,
      // before iOS starts panning its outer viewport. Keep content gestures native.
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
  }
}

export function bindContentScrollGuard(win = window) {
  if (!isIosStandalone(win)) return;
  const main = win.document.querySelector(".app-main");
  const content = main?.querySelector(".app-content");
  if (!main || !content) return;
  const edgeTolerance = 1;
  const updateScrollable = () => {
    const fits = main.scrollHeight - main.clientHeight <= edgeTolerance;
    main.classList.toggle("content-fits", fits);
    win.document.documentElement.classList.toggle("app-content-fits", fits);
  };
  // Both can resize independently: rotation changes the viewport, while
  // navigation, loaded records and font changes change the content height.
  const observer = new win.ResizeObserver(updateScrollable);
  observer.observe(main);
  observer.observe(content);
  updateScrollable();

  const allowsHorizontalDrag = (target) => {
    const control = target?.closest?.('input[type="range"]:enabled, .filter-scroll');
    if (!control || !main.contains(control)) return false;
    if (control.matches('input[type="range"]')) return true;
    return control.scrollWidth - control.clientWidth > edgeTolerance &&
      ["auto", "scroll"].includes(win.getComputedStyle(control).overflowX);
  };
  let previousTouch = null;
  const remember = (touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY });
  main.addEventListener("touchstart", (event) => {
    updateScrollable();
    previousTouch = event.touches.length === 1 ? remember(event.touches[0]) : null;
  }, { passive: true });
  main.addEventListener("touchmove", (event) => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    const maxScroll = main.scrollHeight - main.clientHeight;
    // A fitting screen has no native movement to preserve outside actual
    // horizontal controls. Cancel even the first or sideways move before
    // direction detection can let the viewport start handling the gesture.
    if (maxScroll <= edgeTolerance && !allowsHorizontalDrag(event.target)) {
      previousTouch = touch ? remember(touch) : null;
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (!touch || !previousTouch || touch.identifier !== previousTouch.id) {
      previousTouch = null;
      return;
    }
    const deltaX = touch.clientX - previousTouch.x;
    const deltaY = touch.clientY - previousTouch.y;
    previousTouch = remember(touch);
    // Preserve horizontal filters and range controls. Vertical scrolling is
    // native whenever there is content left in the requested direction.
    if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
    const atBoundary = maxScroll <= edgeTolerance ||
      (deltaY > 0 && main.scrollTop <= edgeTolerance) ||
      (deltaY < 0 && main.scrollTop >= maxScroll - edgeTolerance);
    if (atBoundary && event.cancelable) event.preventDefault();
  }, { passive: false });
  for (const type of ["touchend", "touchcancel"]) {
    main.addEventListener(type, () => { previousTouch = null; }, { passive: true });
  }
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

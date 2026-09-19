const SAMPLE_INTERVAL_MS = 100;
const MAX_SAMPLES = 2400;
const MAX_DURATION_MS = 10 * 60 * 1000;
const MAX_INPUT_EVENTS_PER_SAMPLE = 32;
const LAYOUT_CLASSES = ["ios-standalone-viewport", "app-content-fits", "content-fits"];
const SURFACES = {
  shell: ".app-shell", headerAnchor: ".top-chrome-anchor", header: ".app-header",
  main: ".app-main", content: ".app-content", footerAnchor: ".bottom-chrome-anchor", footer: ".bottom-nav"
};
const PROBE_HEIGHTS = {
  fixedInset: "auto", vh: "100vh", svh: "100svh", dvh: "100dvh", fillAvailable: "-webkit-fill-available",
  innerHeight: null, visualHeight: null, visualViewport: null
};
const PROBE_STYLE = "position:fixed;top:0;bottom:auto;left:0;right:auto;width:0;min-width:0;max-width:none;height:0;min-height:0;max-height:none;margin:0;border:0;padding:0;box-sizing:border-box;visibility:hidden;pointer-events:none;overflow:hidden;transform:none";

const number = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const boolean = (value) => typeof value === "boolean" ? value : null;

function supportsCss(win, ...args) {
  try { return win.CSS?.supports ? win.CSS.supports(...args) : null; } catch { return null; }
}

function scrollbarPseudoStyle(win, element, pseudo) {
  let style;
  try { style = win.getComputedStyle(element, pseudo); } catch { /* Some engines cannot expose these pseudo-elements. */ }
  const values = Object.fromEntries(["display", "width", "height", "visibility", "opacity", "backgroundColor"].map((key) => [key, style?.[key] || null]));
  // Returned CSS is not evidence that a native iOS indicator is actually hidden.
  return { readable: Object.values(values).some((value) => value !== null), ...values };
}

function rectangle(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return Object.fromEntries(["top", "right", "bottom", "left", "width", "height"].map((key) => [key, number(rect[key])]));
}

function scrollMetrics(element) {
  if (!element) return null;
  return Object.fromEntries(["scrollTop", "scrollLeft", "scrollHeight", "scrollWidth", "clientHeight", "clientWidth"].map((key) => [key, number(element[key])]));
}

function surfaceMetrics(win, element, includeScrollbars = false) {
  if (!element) return null;
  const style = win.getComputedStyle(element);
  return {
    rect: rectangle(element), ...scrollMetrics(element),
    ...Object.fromEntries([
      "position", "top", "bottom", "height", "minHeight", "maxHeight", "boxSizing",
      "overflowX", "overflowY", "transform", "filter", "perspective", "contain", "willChange",
      "paddingTop", "paddingBottom", "touchAction"
    ].map((key) => [key, style[key] || null])),
    overscrollY: style.overscrollBehaviorY || null,
    ...(includeScrollbars ? {
      classes: Object.fromEntries(LAYOUT_CLASSES.map((name) => [name, element.classList.contains(name)])),
      scrollbar: {
        width: style.scrollbarWidth || null, color: style.scrollbarColor || null, gutter: style.scrollbarGutter || null,
        webkitScrollbar: scrollbarPseudoStyle(win, element, "::-webkit-scrollbar"),
        webkitScrollbarThumb: scrollbarPseudoStyle(win, element, "::-webkit-scrollbar-thumb")
      }
    } : {})
  };
}

function inputTarget(win, target) {
  const doc = win.document;
  if (!target?.tagName) target = target?.parentElement || target;
  let surface = "other";
  if (target === doc) surface = "document";
  else if (target === doc.documentElement) surface = "html";
  else if (target === doc.body) surface = "body";
  else if (target?.closest?.("dialog")) surface = "dialog";
  else {
    for (const name of ["header", "footer", "main", "shell"]) {
      const element = doc.querySelector(SURFACES[name]);
      if (element && (target === element || element.contains?.(target))) { surface = name; break; }
    }
  }
  // Never serialize arbitrary IDs, classes, text or input values from a target.
  return { surface, tagName: target?.tagName || null };
}

function addButtonMetrics(win) {
  const doc = win.document;
  const button = doc.querySelector("#add-button");
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  const style = win.getComputedStyle(button);
  const hasBox = rect.width > 0 && rect.height > 0;
  const x = hasBox ? rect.left + rect.width / 2 : null;
  const y = hasBox ? rect.top + rect.height / 2 : null;
  const centerHitTest = { x: number(x), y: number(y), status: "no-box", hitsButton: null, target: null };
  if (hasBox) {
    centerHitTest.status = "unavailable";
    if (typeof doc.elementFromPoint === "function") {
      try {
        // Both APIs use client coordinates. Keep the raw point; adding scrollY
        // or visualViewport.offsetTop would test a different location.
        const target = doc.elementFromPoint(x, y);
        centerHitTest.status = target ? "hit" : "no-hit";
        centerHitTest.hitsButton = target ? target === button || button.contains(target) : false;
        centerHitTest.target = target ? inputTarget(win, target) : null;
      } catch { centerHitTest.status = "error"; }
    }
  }
  // A successful hit test does not prove that the compositor painted the button.
  return {
    rect: Object.fromEntries(["top", "right", "bottom", "left", "width", "height"].map((key) => [key, number(rect[key])])),
    hidden: boolean(button.hidden), hiddenAncestor: Boolean(button.parentElement?.closest("[hidden]")),
    ...Object.fromEntries([
      "display", "visibility", "opacity", "position", "top", "right", "bottom", "left", "zIndex", "pointerEvents", "transform"
    ].map((key) => [key, style[key] || null])),
    centerHitTest
  };
}

function createProbes(win) {
  const doc = win.document;
  const make = (name) => {
    const element = doc.createElement("div");
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("data-layout-diagnostic-probe", name);
    element.style.cssText = PROBE_STYLE;
    return element;
  };
  const safeArea = make("safeArea");
  safeArea.style.cssText += ";box-sizing:content-box;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  const viewport = Object.fromEntries(Object.entries(PROBE_HEIGHTS).map(([name, height]) => {
    const element = make(name);
    const supported = height === null || typeof win.CSS?.supports !== "function" ? null : win.CSS.supports("height", height);
    if (height !== null) element.style.height = height;
    if (name === "fixedInset") element.style.bottom = "0px";
    return [name, { element, supported }];
  }));
  // Empty, zero-width fixed siblings only: no app styles, viewport meta,
  // scroll positions or input handling are changed by these measurements.
  doc.body.append(safeArea, ...Object.values(viewport).map(({ element }) => element));
  return { safeArea, viewport };
}

function measureViewportProbes(win, probes) {
  const viewport = win.visualViewport;
  const dynamic = {
    innerHeight: { height: win.innerHeight, top: 0 },
    visualHeight: { height: viewport?.height, top: 0 },
    visualViewport: { height: viewport?.height, top: viewport?.offsetTop }
  };
  // Batch writes to the diagnostic elements before reading any rectangles.
  // No fallback to innerHeight: unavailable viewport data must stay explicit.
  for (const [name, values] of Object.entries(dynamic)) {
    const { element } = probes.viewport[name];
    const available = Number.isFinite(values.height) && values.height > 0 && Number.isFinite(values.top);
    element.style.height = `${available ? values.height : 0}px`;
    element.style.top = `${available ? values.top : 0}px`;
  }
  return Object.fromEntries(Object.entries(probes.viewport).map(([name, { element, supported }]) => {
    const values = dynamic[name];
    const available = values ? Number.isFinite(values.height) && values.height > 0 && Number.isFinite(values.top) : supported !== false;
    return [name, {
      supported, available, requestedHeight: element.style.height, requestedTop: element.style.top,
      computedHeight: available ? win.getComputedStyle(element).height : null,
      rect: available ? rectangle(element) : null
    }];
  }));
}

function probeImpactSnapshot(win) {
  return {
    windowScrollX: number(win.scrollX), windowScrollY: number(win.scrollY),
    root: scrollMetrics(win.document.documentElement), body: scrollMetrics(win.document.body),
    shell: rectangle(win.document.querySelector(".app-shell"))
  };
}

// Only geometry and known UI attributes are read. Never read field values, text,
// IndexedDB, or arbitrary storage: a report must not contain health records.
function snapshot(win, probes) {
  const doc = win.document;
  const root = doc.documentElement;
  const viewportProbes = measureViewportProbes(win, probes);
  const rootStyle = win.getComputedStyle(root);
  const viewport = win.visualViewport;
  const safeStyle = win.getComputedStyle(probes.safeArea);
  const layout = {};
  for (const [name, selector] of Object.entries(SURFACES)) {
    const element = doc.querySelector(selector);
    if (!element) continue;
    layout[name] = surfaceMetrics(win, element, name === "main");
  }
  layout.addButton = addButtonMetrics(win);
  return {
    view: doc.querySelector("section.view:not([hidden])")?.id || null,
    orientation: {
      portrait: win.matchMedia("(orientation: portrait)").matches,
      angle: number(win.screen.orientation?.angle ?? win.orientation),
      type: win.screen.orientation?.type || null
    },
    window: {
      innerWidth: number(win.innerWidth), innerHeight: number(win.innerHeight),
      scrollX: number(win.scrollX), scrollY: number(win.scrollY), devicePixelRatio: number(win.devicePixelRatio)
    },
    screen: { width: number(win.screen.width), height: number(win.screen.height), availWidth: number(win.screen.availWidth), availHeight: number(win.screen.availHeight) },
    visualViewport: viewport ? Object.fromEntries(["width", "height", "offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"].map((key) => [key, number(viewport[key])])) : null,
    viewportCss: Object.fromEntries(["height", "offset-top", "bottom"].map((key) => [key, rootStyle.getPropertyValue(`--visual-viewport-${key}`).trim()])),
    viewportProbes,
    document: {
      root: surfaceMetrics(win, root, true), body: surfaceMetrics(win, doc.body, true), scrollingElement: scrollMetrics(doc.scrollingElement),
      scrollingElementTag: doc.scrollingElement?.tagName || null,
      htmlOverflow: rootStyle.overflow, bodyOverflow: win.getComputedStyle(doc.body).overflow,
      visibility: doc.visibilityState
    },
    safeArea: {
      top: number(Number.parseFloat(safeStyle.paddingTop)), right: number(Number.parseFloat(safeStyle.paddingRight)),
      bottom: number(Number.parseFloat(safeStyle.paddingBottom)), left: number(Number.parseFloat(safeStyle.paddingLeft)),
      shellTopOverride: root.style.getPropertyValue("--shell-safe-top"),
      shellTopComputed: rootStyle.getPropertyValue("--shell-safe-top").trim()
    },
    ui: {
      interface: root.dataset.interface || null, theme: root.dataset.theme || null, glassEffects: root.dataset.glassEffects || null,
      modalOpen: root.classList.contains("modal-open"), keyboardActive: root.classList.contains("entry-keyboard-active"),
      activeElementTag: doc.activeElement?.tagName || null,
      openDialogs: Array.from(doc.querySelectorAll("dialog[open]"), (dialog) => dialog.id)
    },
    layout
  };
}

export function createLayoutDiagnostics({ window: win = globalThis.window, getAppInfo = () => null, onStatusChange = () => {} } = {}) {
  let recording = false;
  let samples = [];
  let nextIndex = 0;
  let dropped = 0;
  let sequence = 0;
  let errors = 0;
  let baseline = null;
  let startedAt = null;
  let stoppedAt = null;
  let startTime = 0;
  let lastSampleTime = -Infinity;
  let pendingTimer = null;
  let probes = null;
  let probeImpact = null;
  let metadata = null;
  let inputEvents = [];
  let inputEventsDropped = 0;
  const pendingReasons = new Set();
  const timers = new Set();
  const rotationTimers = new Set();
  const cleanup = [];

  function status() { return { recording, count: samples.length, dropped, errors, startedAt, stoppedAt }; }

  function capture(reason) {
    if (!recording) return;
    if (reason) pendingReasons.add(reason);
    if (pendingTimer !== null) { win.clearTimeout(pendingTimer); pendingTimer = null; }
    const reasons = [...pendingReasons];
    pendingReasons.clear();
    const now = win.performance.now();
    try {
      const sample = { sequence: ++sequence, elapsedMs: number(now - startTime), reasons, inputEvents, inputEventsDropped, ...snapshot(win, probes) };
      baseline ||= sample;
      if (samples.length < MAX_SAMPLES) samples.push(sample);
      else { samples[nextIndex] = sample; nextIndex = (nextIndex + 1) % MAX_SAMPLES; dropped += 1; }
    } catch { errors += 1; }
    inputEvents = []; inputEventsDropped = 0;
    lastSampleTime = now;
  }

  function queue(reason) {
    if (!recording) return;
    pendingReasons.add(reason);
    if (pendingTimer !== null) return;
    pendingTimer = win.setTimeout(() => { pendingTimer = null; capture(); }, Math.max(0, SAMPLE_INTERVAL_MS - (win.performance.now() - lastSampleTime)));
  }

  function later(reason, delay, group = timers) {
    const timer = win.setTimeout(() => { group.delete(timer); capture(reason); }, delay);
    group.add(timer);
  }

  function observeInput(event) {
    const observation = {
      type: event.type, elapsedMs: number(win.performance.now() - startTime),
      target: inputTarget(win, event.target), touchCount: number(event.touches?.length),
      isTrusted: boolean(event.isTrusted), cancelable: boolean(event.cancelable),
      defaultPreventedAtCapture: boolean(event.defaultPrevented)
    };
    // Preserve the state at the start of a tap, before target/bubble handlers.
    // The regular sample below and its delayed sample capture the state after it.
    if (event.type === "touchstart") observation.addButtonAtCapture = addButtonMetrics(win);
    // A new task runs after all capture/target/bubble handlers, even when one
    // stops propagation. A microtask inside a native listener can run too soon.
    const timer = win.setTimeout(() => {
      timers.delete(timer);
      if (!recording) return;
      observation.defaultPreventedAfterDispatch = boolean(event.defaultPrevented);
      if (inputEvents.length === MAX_INPUT_EVENTS_PER_SAMPLE) { inputEvents.shift(); inputEventsDropped += 1; }
      inputEvents.push(observation);
      if (event.type === "touchmove" || event.type === "wheel") queue(event.type);
      else { capture(event.type); later(`${event.type}+350ms`, 350); }
    }, 0);
    timers.add(timer);
  }

  function rotation(reason) {
    capture(reason);
    for (const timer of rotationTimers) win.clearTimeout(timer);
    rotationTimers.clear();
    for (const delay of [100, 250, 500, 1000, 1800, 3000]) later(`${reason}+${delay}ms`, delay, rotationTimers);
  }

  function listen(target, type, listener) {
    if (!target?.addEventListener) return;
    const options = { passive: true, capture: true };
    target.addEventListener(type, listener, options);
    cleanup.push(() => target.removeEventListener(type, listener, options));
  }

  function stop(reason = "stop") {
    if (!recording) return;
    capture(reason);
    recording = false;
    stoppedAt = new Date().toISOString();
    for (const dispose of cleanup.splice(0)) dispose();
    for (const group of [timers, rotationTimers]) { for (const timer of group) win.clearTimeout(timer); group.clear(); }
    probeImpact.beforeRemoval = probeImpactSnapshot(win);
    probes.safeArea.remove();
    for (const { element } of Object.values(probes.viewport)) element.remove();
    probes = null;
    probeImpact.afterRemoval = probeImpactSnapshot(win);
    onStatusChange(status());
  }

  function start() {
    if (recording) return;
    samples = []; nextIndex = 0; dropped = 0; sequence = 0; errors = 0; baseline = null;
    inputEvents = []; inputEventsDropped = 0;
    pendingReasons.clear(); lastSampleTime = -Infinity;
    startedAt = new Date().toISOString(); stoppedAt = null; startTime = win.performance.now();
    const doc = win.document;
    metadata = {
      userAgent: win.navigator.userAgent, platform: win.navigator.platform, maxTouchPoints: win.navigator.maxTouchPoints,
      standalone: win.navigator.standalone === true || win.matchMedia("(display-mode: standalone)").matches,
      viewportMeta: doc.querySelector('meta[name="viewport"]')?.content || null,
      statusBarStyle: doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content || null,
      cssSupport: {
        scrollbarWidth: supportsCss(win, "scrollbar-width", "none"),
        webkitScrollbarSelector: supportsCss(win, "selector(::-webkit-scrollbar)"),
        webkitScrollbarThumbSelector: supportsCss(win, "selector(::-webkit-scrollbar-thumb)"),
        touchActionPanX: supportsCss(win, "touch-action", "pan-x")
      }
    };
    probeImpact = { beforeInsertion: probeImpactSnapshot(win) };
    probes = createProbes(win);
    recording = true;
    capture("start");
    probeImpact.afterInsertion = probeImpactSnapshot(win);
    listen(win, "orientationchange", () => rotation("orientationchange"));
    listen(win.screen.orientation, "change", () => rotation("screen-orientation"));
    const orientation = win.matchMedia("(orientation: portrait)");
    const handleOrientation = () => rotation("media-orientation");
    if (orientation.addEventListener) listen(orientation, "change", handleOrientation);
    else if (orientation.addListener) { orientation.addListener(handleOrientation); cleanup.push(() => orientation.removeListener(handleOrientation)); }
    listen(win, "resize", () => queue("window-resize"));
    listen(win, "scroll", (event) => { if (event.target === win || event.target === doc) queue("window-scroll"); });
    listen(win.visualViewport, "resize", () => queue("visual-viewport-resize"));
    listen(win.visualViewport, "scroll", () => queue("visual-viewport-scroll"));
    listen(doc, "scroll", (event) => queue(event.target === doc.querySelector(".app-main") ? "main-scroll" : "document-or-nested-scroll"));
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "wheel"]) listen(doc, type, observeInput);
    for (const type of ["click", "focusin", "focusout"]) {
      listen(doc, type, () => { capture(type); later(`${type}+350ms`, 350); });
    }
    listen(doc, "visibilitychange", () => capture("visibilitychange"));
    listen(win, "pagehide", () => capture("pagehide"));
    listen(win, "pageshow", () => rotation("pageshow"));
    listen(win, "popstate", () => { capture("popstate"); later("popstate+350ms", 350); });
    const heartbeat = win.setInterval(() => { if (doc.visibilityState !== "hidden") queue("heartbeat"); }, 1000);
    cleanup.push(() => win.clearInterval(heartbeat));
    const deadline = win.setTimeout(() => stop("duration-limit"), MAX_DURATION_MS);
    cleanup.push(() => win.clearTimeout(deadline));
    onStatusChange(status());
  }

  function report() {
    const info = getAppInfo();
    return {
      format: "myhealth-layout-diagnostics", schemaVersion: 4, exportedAt: new Date().toISOString(),
      app: { version: info?.version || null, buildDate: info?.buildDate || null },
      environment: metadata, ...status(),
      limits: { maxSamples: MAX_SAMPLES, eventSampleIntervalMs: SAMPLE_INTERVAL_MS, maxDurationMs: MAX_DURATION_MS, maxInputEventsPerSample: MAX_INPUT_EVENTS_PER_SAMPLE },
      baseline,
      probeImpact,
      samples: nextIndex ? [...samples.slice(nextIndex), ...samples.slice(0, nextIndex)] : samples.slice()
    };
  }

  function clear() {
    stop();
    samples = []; baseline = null; metadata = null; probeImpact = null; nextIndex = 0; dropped = 0; errors = 0; startedAt = null; stoppedAt = null;
    inputEvents = []; inputEventsDropped = 0;
    onStatusChange(status());
  }

  return { start, stop, clear, status, report };
}

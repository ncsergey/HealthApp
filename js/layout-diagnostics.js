const SAMPLE_INTERVAL_MS = 100;
const MAX_SAMPLES = 2400;
const MAX_DURATION_MS = 10 * 60 * 1000;
const SURFACES = {
  shell: ".app-shell", headerAnchor: ".top-chrome-anchor", header: ".app-header",
  main: ".app-main", content: ".app-content", footerAnchor: ".bottom-chrome-anchor", footer: ".bottom-nav"
};

const number = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

function rectangle(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return Object.fromEntries(["top", "right", "bottom", "left", "width", "height"].map((key) => [key, number(rect[key])]));
}

function scrollMetrics(element) {
  if (!element) return null;
  return Object.fromEntries(["scrollTop", "scrollLeft", "scrollHeight", "scrollWidth", "clientHeight", "clientWidth"].map((key) => [key, number(element[key])]));
}

// Only geometry and known UI attributes are read. Never read field values, text,
// IndexedDB, or arbitrary storage: a report must not contain health records.
function snapshot(win, probe) {
  const doc = win.document;
  const root = doc.documentElement;
  const rootStyle = win.getComputedStyle(root);
  const viewport = win.visualViewport;
  const safeStyle = win.getComputedStyle(probe);
  const layout = {};
  for (const [name, selector] of Object.entries(SURFACES)) {
    const element = doc.querySelector(selector);
    if (!element) continue;
    const style = win.getComputedStyle(element);
    layout[name] = {
      rect: rectangle(element), ...scrollMetrics(element),
      position: style.position, top: style.top, bottom: style.bottom,
      overflowX: style.overflowX, overflowY: style.overflowY,
      overscrollY: style.overscrollBehaviorY, transform: style.transform,
      paddingTop: style.paddingTop, paddingBottom: style.paddingBottom
    };
  }
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
    document: {
      root: scrollMetrics(root), body: scrollMetrics(doc.body), scrollingElement: scrollMetrics(doc.scrollingElement),
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
  let probe = null;
  let metadata = null;
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
      const sample = { sequence: ++sequence, elapsedMs: number(now - startTime), reasons, ...snapshot(win, probe) };
      baseline ||= sample;
      if (samples.length < MAX_SAMPLES) samples.push(sample);
      else { samples[nextIndex] = sample; nextIndex = (nextIndex + 1) % MAX_SAMPLES; dropped += 1; }
    } catch { errors += 1; }
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
    probe?.remove();
    probe = null;
    onStatusChange(status());
  }

  function start() {
    if (recording) return;
    samples = []; nextIndex = 0; dropped = 0; sequence = 0; errors = 0; baseline = null;
    pendingReasons.clear(); lastSampleTime = -Infinity;
    startedAt = new Date().toISOString(); stoppedAt = null; startTime = win.performance.now();
    const doc = win.document;
    metadata = {
      userAgent: win.navigator.userAgent, platform: win.navigator.platform, maxTouchPoints: win.navigator.maxTouchPoints,
      standalone: win.navigator.standalone === true || win.matchMedia("(display-mode: standalone)").matches,
      viewportMeta: doc.querySelector('meta[name="viewport"]')?.content || null,
      statusBarStyle: doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content || null
    };
    probe = doc.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;margin:0;border:0;box-sizing:content-box;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
    doc.body.append(probe);
    recording = true;
    capture("start");
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
    for (const type of ["touchmove", "wheel"]) listen(doc, type, () => queue(type));
    for (const type of ["touchstart", "touchend", "touchcancel", "click", "focusin", "focusout"]) {
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
      format: "myhealth-layout-diagnostics", schemaVersion: 1, exportedAt: new Date().toISOString(),
      app: { version: info?.version || null, buildDate: info?.buildDate || null },
      environment: metadata, ...status(),
      limits: { maxSamples: MAX_SAMPLES, eventSampleIntervalMs: SAMPLE_INTERVAL_MS, maxDurationMs: MAX_DURATION_MS },
      baseline,
      samples: nextIndex ? [...samples.slice(nextIndex), ...samples.slice(0, nextIndex)] : samples.slice()
    };
  }

  function clear() {
    stop();
    samples = []; baseline = null; metadata = null; nextIndex = 0; dropped = 0; errors = 0; startedAt = null; stoppedAt = null;
    onStatusChange(status());
  }

  return { start, stop, clear, status, report };
}

import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutDiagnostics } from "../js/layout-diagnostics.js";
import { exportLayoutDiagnostics } from "../js/export.js";

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, callback, options) {
      assert.equal(options.passive, true, "Diagnostics must never block native gestures");
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatch(type, target = this, properties = {}) {
      const event = { type, target, cancelable: true, defaultPrevented: false, isTrusted: false, ...properties };
      for (const callback of [...listeners.get(type) || []]) callback(event);
      return event;
    }
  };
}

function fixture() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const styles = { position: "relative", top: "auto", bottom: "auto", overflow: "hidden", overflowX: "hidden", overflowY: "auto", overscrollBehaviorY: "contain", transform: "none", paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px", getPropertyValue: () => "0px" };
  const surface = (tagName = "DIV") => ({
    tagName, style: { getPropertyValue: () => "0px" }, styles: { ...styles, touchAction: "auto" }, pseudoStyles: {}, dataset: {},
    classList: { values: new Set(), contains(name) { return this.values.has(name); } },
    scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, scrollWidth: 375, clientHeight: 647, clientWidth: 375,
    rect: { top: 0, right: 375, bottom: 647, left: 0, width: 375, height: 647 },
    getBoundingClientRect() { return { ...this.rect }; }, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    scrollTo() { assert.fail("Diagnostics must not change scroll position"); }
  });
  const children = new Set();
  const root = surface("HTML");
  const body = surface("BODY");
  body.append = (...nodes) => { for (const node of nodes) { children.add(node); node.remove = () => children.delete(node); } };
  const nodes = Object.fromEntries([".app-shell", ".top-chrome-anchor", ".app-header", ".app-main", ".app-content", ".bottom-chrome-anchor", ".bottom-nav"].map((selector) => [selector, surface()]));
  const button = nodes["#add-button"] = surface("BUTTON");
  const icon = { tagName: "SPAN", id: "PRIVATE MEDICAL TEXT", textContent: "PRIVATE MEDICAL TEXT" };
  button.hidden = false;
  button.parentElement = { hidden: false, closest: function () { return this.hidden ? this : null; } };
  button.contains = (target) => target === icon;
  button.rect = { top: 500, right: 352, bottom: 552, left: 300, width: 52, height: 52 };
  Object.assign(button.styles, { display: "inline-flex", visibility: "visible", opacity: "1", position: "fixed", zIndex: "16", pointerEvents: "auto" });
  nodes[".app-main"].contains = (target) => target === button || button.contains(target);
  const doc = {
    ...eventTarget(), documentElement: root, body, scrollingElement: root, visibilityState: "visible",
    activeElement: { tagName: "INPUT", get value() { assert.fail("Do not read health input values"); }, textContent: "PRIVATE MEDICAL TEXT" },
    view: { id: "diary-view" },
    querySelector(selector) {
      if (selector === "section.view:not([hidden])") return this.view;
      if (selector === 'meta[name="viewport"]') return { content: "width=device-width, initial-scale=1, viewport-fit=cover" };
      if (selector === 'meta[name="apple-mobile-web-app-status-bar-style"]') return { content: "default" };
      return nodes[selector] || null;
    },
    hitTarget: icon,
    elementFromPoint(x, y) { this.hitPoint = { x, y }; return this.hitTarget; },
    querySelectorAll: () => [],
    createElement: () => surface()
  };
  const orientation = { ...eventTarget(), matches: true };
  const win = {
    ...eventTarget(), document: doc, performance: { now: () => now },
    navigator: { userAgent: "test iPhone", platform: "iPhone", maxTouchPoints: 5, standalone: true },
    screen: { width: 375, height: 667, availWidth: 375, availHeight: 647, orientation: { ...eventTarget(), angle: 0, type: "portrait-primary" } },
    innerWidth: 375, innerHeight: 647, scrollX: 0, scrollY: 0, devicePixelRatio: 2,
    CSS: { supports: () => true },
    visualViewport: { ...eventTarget(), width: 375, height: 647, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 },
    matchMedia: (query) => query === "(orientation: portrait)" ? orientation : { matches: true },
    getComputedStyle: (node, pseudo) => pseudo ? node.pseudoStyles[pseudo] || {} : node.styles,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, time: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, time: now + delay, interval: delay }); return id; },
    clearInterval: (id) => timers.delete(id)
  };
  function advance(delay) {
    const end = now + delay;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.time;
      if (timer.interval) timer.time += timer.interval; else timers.delete(id);
      timer.fn();
    }
    now = end;
  }
  const logger = createLayoutDiagnostics({ window: win, getAppInfo: () => ({ version: "1.0.16", buildDate: "19.09.26 00:00", healthData: "PRIVATE MEDICAL TEXT" }) });
  return { logger, win, doc, nodes, orientation, children, timers, advance };
}

test("diagnostics are opt-in and stop removes every listener, timer and probe", () => {
  const { logger, win, doc, orientation, children, timers, advance } = fixture();
  assert.equal(logger.status().recording, false);
  assert.equal(timers.size, 0);
  assert.equal(children.size, 0);
  assert.equal(win.listeners.size, 0);
  logger.start();
  logger.start();
  assert.equal(children.size, 9);
  assert.equal(logger.status().count, 1);
  doc.dispatch("touchmove");
  logger.stop();
  const count = logger.status().count;
  advance(10_000);
  assert.equal(logger.status().count, count);
  assert.equal(timers.size, 0);
  assert.equal(children.size, 0);
  const { probeImpact } = logger.report();
  assert.deepEqual(probeImpact.beforeInsertion, probeImpact.afterInsertion);
  assert.deepEqual(probeImpact.beforeRemoval, probeImpact.afterRemoval);
  for (const target of [win, doc, orientation, win.visualViewport, win.screen.orientation]) {
    for (const callbacks of target.listeners.values()) assert.equal(callbacks.size, 0);
  }
  logger.clear();
  assert.equal(logger.status().count, 0);
  assert.equal(logger.report().baseline, null);
  assert.equal(logger.report().probeImpact, null);
});

test("viewport probes keep raw browser geometry separate from requested sizing and do not write app styles", () => {
  const { logger, win, doc, nodes, children, advance } = fixture();
  const appStyles = [doc.documentElement, doc.body, ...Object.values(nodes)].map((node) => node.style);
  const beforeStyles = appStyles.map((style) => ({ ...style }));
  logger.start();
  const probes = Object.fromEntries([...children].map((element) => [element.attributes["data-layout-diagnostic-probe"], element]));
  win.visualViewport.offsetTop = 20;
  win.visualViewport.height = 647;
  doc.documentElement.styles.height = "667px";
  doc.documentElement.rect.height = 667;
  // Browser responses are deliberately different from the requested lengths:
  // logging must not report an assumed dvh fix or subtract the offset itself.
  probes.dvh.styles.height = "667px";
  probes.dvh.rect = { top: -20, bottom: 647, left: 0, right: 0, width: 0, height: 667 };
  probes.visualHeight.rect = { top: -20, bottom: 627, left: 0, right: 0, width: 0, height: 647 };
  probes.visualViewport.rect = { top: 0, bottom: 647, left: 0, right: 0, width: 0, height: 647 };
  win.visualViewport.dispatch("resize");
  advance(100);
  const report = logger.report();
  const sample = report.samples.at(-1);
  assert.equal(report.schemaVersion, 4);
  assert.equal(sample.viewportProbes.dvh.requestedHeight, "100dvh");
  assert.equal(sample.viewportProbes.dvh.computedHeight, "667px");
  assert.equal(sample.viewportProbes.dvh.rect.height, 667);
  assert.equal(sample.viewportProbes.visualHeight.requestedHeight, "647px");
  assert.equal(sample.viewportProbes.visualHeight.requestedTop, "0px");
  assert.equal(sample.viewportProbes.visualHeight.rect.top, -20);
  assert.equal(sample.viewportProbes.visualViewport.requestedTop, "20px");
  assert.equal(sample.viewportProbes.visualViewport.rect.top, 0);
  assert.equal(sample.document.root.height, "667px");
  assert.equal(sample.document.root.rect.height, 667);
  assert.equal(report.baseline.viewportProbes.visualViewport.requestedTop, "0px");
  logger.stop();
  assert.deepEqual(appStyles, beforeStyles);
  assert.equal(children.size, 0);
  assert.equal(report.errors, 0);
});

test("unsupported CSS lengths and a missing visual viewport are reported as unavailable without a fallback", () => {
  const { logger, win } = fixture();
  win.CSS.supports = (_, value) => !["100dvh", "100svh", "-webkit-fill-available"].includes(value);
  win.visualViewport = null;
  logger.start();
  const sample = logger.report().baseline;
  for (const name of ["dvh", "svh", "fillAvailable", "visualHeight", "visualViewport"]) {
    assert.equal(sample.viewportProbes[name].available, false);
    assert.equal(sample.viewportProbes[name].rect, null);
  }
  assert.equal(sample.viewportProbes.dvh.supported, false);
  assert.equal(sample.viewportProbes.innerHeight.requestedHeight, "647px");
  assert.equal(sample.viewportProbes.innerHeight.available, true);
  logger.stop();
  assert.equal(logger.status().errors, 0);
});

test("rotation keeps the prior baseline and captures delayed viewport, safe-area and scroll changes without field values", () => {
  const { logger, win, doc, nodes, children, advance } = fixture();
  logger.start();
  win.dispatch("orientationchange");
  advance(1700);
  win.visualViewport.offsetTop = 20;
  win.scrollY = 10;
  doc.scrollingElement.scrollTop = 10;
  doc.view.id = "medications-view";
  nodes[".app-header"].rect.top = -20;
  nodes[".app-main"].scrollTop = 75;
  [...children][0].styles.paddingTop = "20px";
  advance(1100);
  const at1800 = logger.report().samples.find((sample) => sample.reasons.includes("orientationchange+1800ms"));
  assert.equal(at1800.visualViewport.offsetTop, 20);
  assert.equal(at1800.window.scrollY, 10);
  assert.equal(at1800.document.scrollingElement.scrollTop, 10);
  assert.equal(at1800.layout.main.scrollTop, 75);
  assert.equal(at1800.layout.header.rect.top, -20);
  assert.equal(at1800.safeArea.top, 20);
  assert.equal(at1800.view, "medications-view");
  advance(200);
  logger.stop();
  const report = logger.report();
  assert.equal(report.baseline.visualViewport.offsetTop, 0);
  assert.equal(report.baseline.layout.header.rect.top, 0);
  assert.ok(report.samples.some((sample) => sample.reasons.includes("orientationchange+3000ms")));
  assert.equal(report.environment.standalone, true);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE MEDICAL TEXT|healthData/);
  assert.equal(report.errors, 0);
});

test("touch movement is sampled even without scroll events, with high-frequency events combined", () => {
  const { logger, doc, win, advance } = fixture();
  logger.start();
  for (let i = 0; i < 200; i++) { doc.dispatch("touchmove"); win.visualViewport.dispatch("scroll"); }
  advance(99);
  assert.equal(logger.status().count, 1);
  advance(1);
  assert.equal(logger.status().count, 2);
  const sample = logger.report().samples[1];
  assert.deepEqual(new Set(sample.reasons), new Set(["touchmove", "visual-viewport-scroll"]));
  assert.equal(sample.inputEvents.length, logger.report().limits.maxInputEventsPerSample);
  assert.equal(sample.inputEventsDropped, 200 - sample.inputEvents.length);
  logger.stop();
});

test("button measurements preserve pre-rotation, post-rotation and both sides of touch dispatch", () => {
  const { logger, win, doc, nodes, advance } = fixture();
  const button = nodes["#add-button"];
  logger.start();
  const baseline = logger.report().baseline.layout.addButton;
  assert.deepEqual(baseline.centerHitTest, { x: 326, y: 526, status: "hit", hitsButton: true, target: { surface: "main", tagName: "SPAN" } });
  assert.equal(baseline.hidden, false);
  assert.equal(baseline.hiddenAncestor, false);
  assert.equal(baseline.display, "inline-flex");
  assert.equal(baseline.visibility, "visible");

  button.rect = { top: 201.234, right: 572.123, bottom: 253.234, left: 520.123, width: 52, height: 52 };
  button.styles.opacity = "0";
  win.scrollY = win.visualViewport.offsetTop = 20;
  win.dispatch("orientationchange");
  advance(100);
  const rotated = logger.report().samples.find((sample) => sample.reasons.includes("orientationchange+100ms")).layout.addButton;
  assert.equal(rotated.rect.top, 201.23);
  assert.equal(rotated.rect.left, 520.12);
  assert.equal(rotated.opacity, "0");
  assert.deepEqual(doc.hitPoint, { x: 546.123, y: 227.234 }, "Hit testing uses the unrounded client center without viewport or scroll corrections");
  assert.equal(rotated.centerHitTest.x, 546.12);
  assert.equal(rotated.centerHitTest.y, 227.23);

  doc.dispatch("touchstart", nodes[".app-main"], { touches: [{}] });
  // Model a target/bubble handler changing the button during the same dispatch.
  button.styles.opacity = "1";
  advance(0);
  const touched = logger.report().samples.at(-1);
  assert.ok(touched.reasons.includes("touchstart"));
  assert.equal(touched.inputEvents[0].addButtonAtCapture.opacity, "0");
  assert.equal(touched.layout.addButton.opacity, "1");
  advance(350);
  const settled = logger.report().samples.find((sample) => sample.reasons.includes("touchstart+350ms"));
  assert.equal(settled.layout.addButton.opacity, "1");
  assert.equal(baseline.opacity, "1");
  assert.equal(baseline.rect.top, 500);
  assert.doesNotMatch(JSON.stringify(logger.report()), /PRIVATE MEDICAL TEXT|healthData/);
  logger.stop();
});

test("button diagnostics distinguish hidden ancestors, no box, coverage and an empty hit test", () => {
  const { logger, doc, nodes } = fixture();
  const button = nodes["#add-button"];
  const take = () => { doc.dispatch("click"); return logger.report().samples.at(-1).layout.addButton; };
  logger.start();
  doc.hitTarget = { tagName: "DIALOG", id: "PRIVATE MEDICAL TEXT", closest: () => ({}) };
  let metric = take();
  assert.equal(metric.centerHitTest.hitsButton, false);
  assert.deepEqual(metric.centerHitTest.target, { surface: "dialog", tagName: "DIALOG" });
  doc.hitTarget = null;
  metric = take();
  assert.equal(metric.centerHitTest.status, "no-hit");
  assert.equal(metric.centerHitTest.hitsButton, false);
  assert.equal(metric.centerHitTest.target, null);

  button.parentElement.hidden = true;
  button.rect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
  doc.elementFromPoint = () => assert.fail("A zero-size hidden button has no center to test");
  metric = take();
  assert.equal(metric.hidden, false);
  assert.equal(metric.hiddenAncestor, true);
  assert.equal(metric.display, "inline-flex", "An element's own display need not change inside a hidden view");
  assert.deepEqual(metric.centerHitTest, { x: null, y: null, status: "no-box", hitsButton: null, target: null });
  button.hidden = true;
  button.styles.display = "none";
  button.styles.visibility = "hidden";
  metric = take();
  assert.equal(metric.hidden, true);
  assert.equal(metric.display, "none");
  assert.equal(metric.visibility, "hidden");
  assert.doesNotMatch(JSON.stringify(logger.report()), /PRIVATE MEDICAL TEXT/);
  logger.stop();
  assert.equal(logger.status().errors, 0);
});

test("missing buttons and unavailable hit tests are explicit without interrupting recording", () => {
  const { logger, doc, nodes, advance } = fixture();
  delete doc.elementFromPoint;
  logger.start();
  let metric = logger.report().baseline.layout.addButton;
  assert.equal(metric.centerHitTest.status, "unavailable");
  assert.equal(metric.centerHitTest.hitsButton, null);
  doc.elementFromPoint = () => { throw new Error("Hit testing unavailable"); };
  doc.dispatch("touchstart");
  advance(0);
  metric = logger.report().samples.at(-1).layout.addButton;
  assert.equal(metric.centerHitTest.status, "error");
  assert.equal(metric.centerHitTest.hitsButton, null);
  delete nodes["#add-button"];
  doc.dispatch("touchstart");
  advance(0);
  const sample = logger.report().samples.at(-1);
  assert.equal(sample.layout.addButton, null);
  assert.equal(sample.inputEvents[0].addButtonAtCapture, null);
  logger.stop();
  assert.equal(logger.status().errors, 0);
});

test("classes, touch-action and both scrollbar styles are sampled again after layout changes", () => {
  const { logger, doc, nodes, win, advance } = fixture();
  const elements = [doc.documentElement, doc.body, nodes[".app-main"]];
  for (const element of elements) {
    element.styles.scrollbarWidth = "none";
    element.styles.touchAction = "pan-x";
    element.pseudoStyles["::-webkit-scrollbar"] = { display: "none", width: "0px", height: "0px", visibility: "visible", opacity: "1" };
    element.pseudoStyles["::-webkit-scrollbar-thumb"] = { display: "inline", backgroundColor: "rgba(0, 0, 0, 0)" };
  }
  doc.documentElement.classList.values.add("ios-standalone-viewport");
  doc.documentElement.classList.values.add("app-content-fits");
  doc.documentElement.classList.values.add("PRIVATE MEDICAL TEXT");
  nodes[".app-main"].classList.values.add("content-fits");
  logger.start();
  const sample = logger.report().baseline;
  assert.equal(sample.document.root.classes["ios-standalone-viewport"], true);
  assert.equal(sample.document.root.classes["app-content-fits"], true);
  assert.equal(sample.layout.main.classes["content-fits"], true);
  for (const metric of [sample.document.root, sample.document.body, sample.layout.main]) {
    assert.equal(metric.touchAction, "pan-x");
    assert.equal(metric.scrollbar.width, "none");
    assert.equal(metric.scrollbar.webkitScrollbar.readable, true);
    assert.equal(metric.scrollbar.webkitScrollbar.display, "none");
    assert.equal(metric.scrollbar.webkitScrollbarThumb.backgroundColor, "rgba(0, 0, 0, 0)");
  }
  nodes[".app-main"].classList.values.delete("content-fits");
  nodes[".app-main"].styles.scrollbarWidth = "auto";
  nodes[".app-main"].pseudoStyles["::-webkit-scrollbar"].display = "inline";
  win.dispatch("resize");
  advance(100);
  const next = logger.report().samples.at(-1).layout.main;
  assert.equal(next.classes["content-fits"], false);
  assert.equal(next.scrollbar.width, "auto");
  assert.equal(next.scrollbar.webkitScrollbar.display, "inline");
  assert.equal(sample.layout.main.scrollbar.webkitScrollbar.display, "none", "The baseline must remain immutable");
  assert.doesNotMatch(JSON.stringify(logger.report()), /PRIVATE MEDICAL TEXT/);
  logger.stop();
});

test("unavailable scrollbar properties and pseudo styles remain unknown without breaking diagnostics", () => {
  const { logger, win } = fixture();
  const originalComputedStyle = win.getComputedStyle;
  win.CSS.supports = () => false;
  win.getComputedStyle = (node, pseudo) => {
    if (pseudo) throw new Error("Pseudo-element styles are unavailable");
    return originalComputedStyle(node);
  };
  logger.start();
  const report = logger.report();
  assert.equal(report.environment.cssSupport.scrollbarWidth, false);
  assert.equal(report.environment.cssSupport.webkitScrollbarSelector, false);
  for (const metric of [report.baseline.document.root, report.baseline.document.body, report.baseline.layout.main]) {
    assert.equal(metric.scrollbar.width, null);
    assert.equal(metric.scrollbar.webkitScrollbar.readable, false);
    assert.equal(metric.scrollbar.webkitScrollbar.display, null);
    assert.equal(metric.scrollbar.webkitScrollbarThumb.readable, false);
  }
  assert.equal(report.errors, 0);
  logger.stop();
});

test("gesture cancellation is read after dispatch, with target and cancelability kept separate", () => {
  const { logger, doc, nodes, advance } = fixture();
  logger.start();
  const move = doc.dispatch("touchmove", nodes[".app-main"], { touches: [{}] });
  // The application handles the event after our capture listener returns.
  move.defaultPrevented = true;
  doc.dispatch("touchmove", doc.activeElement, { cancelable: false, touches: [{}] });
  advance(100);
  const events = logger.report().samples.at(-1).inputEvents;
  assert.equal(events.length, 2);
  assert.equal(events[0].target.surface, "main");
  assert.equal(events[0].cancelable, true);
  assert.equal(events[0].defaultPreventedAtCapture, false);
  assert.equal(events[0].defaultPreventedAfterDispatch, true);
  assert.equal(events[0].touchCount, 1);
  assert.equal(events[1].target.tagName, "INPUT");
  assert.equal(events[1].cancelable, false);
  assert.equal(events[1].defaultPreventedAfterDispatch, false);
  assert.doesNotMatch(JSON.stringify(logger.report()), /PRIVATE MEDICAL TEXT|healthData/);
  doc.dispatch("touchstart");
  logger.stop();
  logger.start();
  advance(100);
  assert.deepEqual(logger.report().samples.flatMap((sample) => sample.inputEvents), [], "Deferred results must not leak into a new recording");
  logger.stop();
});

test("a full buffer retains chronological recent samples and the original baseline", () => {
  const { logger, doc, advance } = fixture();
  logger.start();
  const limit = logger.report().limits.maxSamples;
  for (let i = 0; i < limit + 7; i++) { doc.dispatch("touchstart"); advance(0); }
  logger.stop();
  const report = logger.report();
  assert.equal(report.samples.length, limit);
  assert.equal(report.baseline.sequence, 1);
  assert.equal(report.dropped, 9);
  assert.equal(report.samples.at(-1).sequence, limit + 9);
  assert.ok(report.samples.every((sample, i) => i === 0 || sample.sequence === report.samples[i - 1].sequence + 1));
});

test("recording automatically stops after ten minutes and a new session starts clean", () => {
  const { logger, advance, timers } = fixture();
  logger.start();
  advance(logger.report().limits.maxDurationMs);
  assert.equal(logger.status().recording, false);
  assert.ok(logger.report().samples.at(-1).reasons.includes("duration-limit"));
  assert.equal(timers.size, 0);
  logger.start();
  assert.equal(logger.status().count, 1);
  assert.equal(logger.report().baseline.sequence, 1);
  logger.stop();
});

test("JSON export uses file sharing and keeps cancellation distinct from a successful save", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let sharedFile;
  const report = { exportedAt: "2026-09-19T00:00:00.000Z", format: "myhealth-layout-diagnostics", samples: [] };
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      canShare: ({ files }) => files.length === 1,
      share: async ({ files }) => { sharedFile = files[0]; }
    } });
    assert.equal(await exportLayoutDiagnostics(report), true);
    assert.equal(sharedFile.type, "application/json");
    assert.match(sharedFile.name, /^myhealth-layout-.*\.json$/);
    assert.deepEqual(JSON.parse(await sharedFile.text()), report);
    globalThis.navigator.share = async () => { throw Object.assign(new Error("Cancelled"), { name: "AbortError" }); };
    assert.equal(await exportLayoutDiagnostics(report), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else delete globalThis.navigator;
  }
});

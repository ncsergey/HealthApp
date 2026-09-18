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
    dispatch(type, target = this) { for (const callback of [...listeners.get(type) || []]) callback({ type, target }); }
  };
}

function fixture() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const styles = { position: "relative", top: "auto", bottom: "auto", overflow: "hidden", overflowX: "hidden", overflowY: "auto", overscrollBehaviorY: "contain", transform: "none", paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px", getPropertyValue: () => "0px" };
  const surface = (tagName = "DIV") => ({
    tagName, style: { getPropertyValue: () => "0px" }, styles: { ...styles }, dataset: {}, classList: { contains: () => false },
    scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, scrollWidth: 375, clientHeight: 647, clientWidth: 375,
    rect: { top: 0, right: 375, bottom: 647, left: 0, width: 375, height: 647 },
    getBoundingClientRect() { return { ...this.rect }; }, setAttribute() {},
    scrollTo() { assert.fail("Diagnostics must not change scroll position"); }
  });
  const children = new Set();
  const root = surface("HTML");
  const body = surface("BODY");
  body.append = (node) => { children.add(node); node.remove = () => children.delete(node); };
  const nodes = Object.fromEntries([".app-shell", ".top-chrome-anchor", ".app-header", ".app-main", ".app-content", ".bottom-chrome-anchor", ".bottom-nav"].map((selector) => [selector, surface()]));
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
    querySelectorAll: () => [],
    createElement: () => surface()
  };
  const orientation = { ...eventTarget(), matches: true };
  const win = {
    ...eventTarget(), document: doc, performance: { now: () => now },
    navigator: { userAgent: "test iPhone", platform: "iPhone", maxTouchPoints: 5, standalone: true },
    screen: { width: 375, height: 667, availWidth: 375, availHeight: 647, orientation: { ...eventTarget(), angle: 0, type: "portrait-primary" } },
    innerWidth: 375, innerHeight: 647, scrollX: 0, scrollY: 0, devicePixelRatio: 2,
    visualViewport: { ...eventTarget(), width: 375, height: 647, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 },
    matchMedia: (query) => query === "(orientation: portrait)" ? orientation : { matches: true },
    getComputedStyle: (node) => node.styles,
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
  assert.equal(children.size, 1);
  assert.equal(logger.status().count, 1);
  doc.dispatch("touchmove");
  logger.stop();
  const count = logger.status().count;
  advance(10_000);
  assert.equal(logger.status().count, count);
  assert.equal(timers.size, 0);
  assert.equal(children.size, 0);
  for (const target of [win, doc, orientation, win.visualViewport, win.screen.orientation]) {
    for (const callbacks of target.listeners.values()) assert.equal(callbacks.size, 0);
  }
  logger.clear();
  assert.equal(logger.status().count, 0);
  assert.equal(logger.report().baseline, null);
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
  assert.deepEqual(logger.report().samples[1].reasons, ["touchmove", "visual-viewport-scroll"]);
  logger.stop();
});

test("a full buffer retains chronological recent samples and the original baseline", () => {
  const { logger, doc } = fixture();
  logger.start();
  const limit = logger.report().limits.maxSamples;
  for (let i = 0; i < limit + 7; i++) doc.dispatch("touchstart");
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

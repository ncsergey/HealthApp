import assert from "node:assert/strict";
import test from "node:test";
import { bindPanelDragGuard, syncVisualViewport } from "../js/viewport.js";

function fixture(navigator = { userAgent: "iPhone OS 16_7_16", platform: "iPhone", standalone: true }) {
  const properties = new Map();
  const classes = new Set();
  const win = {
    navigator, innerHeight: 647, visualViewport: { height: 647, offsetTop: 0 },
    matchMedia: () => ({ matches: false }),
    document: { documentElement: {
      clientHeight: 647,
      style: { getPropertyValue: (name) => properties.get(name) || "", setProperty: (name, value) => properties.set(name, value) },
      classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) }
    } },
    scrollTo() { assert.fail("Viewport synchronization must not scroll the document"); }
  };
  return { win, properties, classes };
}

test("the recorded iOS rotation and intermediate pan offsets are applied synchronously, including the 667/647 mismatch", () => {
  const { win, properties, classes } = fixture();
  // Geometry from the iPhone 8 report: height alone leaves the fixed shell
  // shifted. Each event must apply the matching offset before it returns.
  for (const [layout, height, offset] of [[647, 647, 0], [375, 375, 0], [667, 667, 0], [667, 647, 20], [667, 647, 9], [667, 647, 0], [667, 647, 14], [667, 647, 20]]) {
    win.document.documentElement.clientHeight = layout;
    win.innerHeight = height;
    Object.assign(win.visualViewport, { height, offsetTop: offset });
    syncVisualViewport(win);
    assert.equal(properties.get("--visual-viewport-height"), `${height}px`);
    assert.equal(properties.get("--visual-viewport-offset-top"), `${offset}px`);
    assert.ok(classes.has("ios-standalone-viewport"));
  }
});

test("only installed iOS apps use the shell override; other platforms retain viewport values for dialogs", () => {
  const cases = [
    [{ userAgent: "iPhone", platform: "iPhone", standalone: true }, false, true],
    [{ userAgent: "iPhone", platform: "iPhone" }, true, true],
    [{ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5, standalone: true }, false, true],
    [{ userAgent: "iPhone", platform: "iPhone", standalone: false }, false, false],
    [{ userAgent: "Android", platform: "Linux armv81" }, true, false],
    [{ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 }, true, false],
    [{ userAgent: "Windows", platform: "Win32" }, true, false]
  ];
  for (const [navigator, standaloneMedia, expected] of cases) {
    const { win, properties, classes } = fixture(navigator);
    win.matchMedia = () => ({ matches: standaloneMedia });
    syncVisualViewport(win);
    assert.equal(classes.has("ios-standalone-viewport"), expected, JSON.stringify(navigator));
    assert.equal(properties.get("--visual-viewport-height"), "647px");
  }
});

test("missing or temporarily invalid visual viewport data cannot overwrite valid geometry", () => {
  const { win, properties, classes } = fixture();
  const valid = win.visualViewport;
  win.visualViewport = null;
  syncVisualViewport(win);
  assert.equal(properties.size, 0);
  assert.equal(classes.size, 0);
  win.visualViewport = valid;
  syncVisualViewport(win);
  const before = new Map(properties);
  for (const viewport of [{ height: 0, offsetTop: 0 }, { height: NaN, offsetTop: 0 }, { height: 647, offsetTop: Infinity }, null]) {
    win.visualViewport = viewport;
    syncVisualViewport(win);
    assert.deepEqual(properties, before);
  }
});

test("viewport updates leave keyboard freezing and safe-area state to their existing owners", () => {
  const { win, properties, classes } = fixture();
  properties.set("--shell-safe-top", "0px");
  properties.set("--entry-keyboard-shell-height", "647px");
  classes.add("entry-keyboard-active");
  win.visualViewport.height = 320;
  syncVisualViewport(win);
  assert.equal(properties.get("--visual-viewport-height"), "320px");
  assert.equal(properties.get("--entry-keyboard-shell-height"), "647px");
  assert.equal(properties.get("--shell-safe-top"), "0px");
  assert.ok(classes.has("entry-keyboard-active"));
});

test("panel drag guard cancels moves but leaves taps and the content scroller alone", () => {
  const { win } = fixture();
  const nodes = Object.fromEntries([".app-header", ".bottom-nav", ".app-main"].map((selector) => [selector, new EventTarget()]));
  win.document.querySelector = (selector) => nodes[selector];
  bindPanelDragGuard(win);
  for (const [selector, target] of Object.entries(nodes)) {
    for (const type of ["touchstart", "touchmove", "touchend", "click"]) {
      const event = new Event(type, { cancelable: true });
      target.dispatchEvent(event);
      assert.equal(event.defaultPrevented, type === "touchmove" && selector !== ".app-main", `${selector}: ${type}`);
    }
  }
  assert.doesNotThrow(() => nodes[".app-header"].dispatchEvent(new Event("touchmove", { cancelable: false })));
});

test("panel gesture interception is restricted to installed iOS apps", () => {
  for (const navigator of [{ userAgent: "iPhone", standalone: false }, { userAgent: "Android", standalone: true }]) {
    const { win } = fixture(navigator);
    win.document.querySelector = () => assert.fail("Do not install panel touch listeners outside iOS PWA");
    bindPanelDragGuard(win);
  }
});

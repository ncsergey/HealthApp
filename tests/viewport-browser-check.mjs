import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.MYHEALTH_PLAYWRIGHT_MODULE || "playwright-core");
const root = fileURLToPath(new URL("..", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".md": "text/plain" };
let executablePath;
for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* Try the next installed browser. */ }
}
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const target = resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!target.startsWith(resolve(root) + sep)) throw new Error("Outside project");
    const data = await readFile(target);
    response.writeHead(200, { "content-type": mime[extname(target)] || "application/octet-stream", "cache-control": "no-store" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

const iosAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_16 like Mac OS X) AppleWebKit/605.1.15 Version/16.6.2 Mobile/15E148 Safari/604.1";
const errors = [];
let browser;

async function createPage(userAgent = iosAgent, standalone = true) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 647 }, screen: { width: 375, height: 667 },
    hasTouch: true, isMobile: true, userAgent, serviceWorkers: "block"
  });
  await context.addInitScript((standalone) => {
    const viewport = Object.assign(new EventTarget(), { width: 375, height: 647, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    Object.defineProperty(window, "innerHeight", { get: () => viewport.height, configurable: true });
    Object.defineProperty(navigator, "standalone", { value: standalone, configurable: true });
    window.setTestViewport = (values, event = "resize", shiftLayout = true) => {
      Object.assign(viewport, values, { pageTop: values.offsetTop ?? viewport.offsetTop });
      // Chromium does not reproduce the iOS bug. Move the fixed containing
      // block explicitly to model the coordinate displacement from the log.
      // This tests our CSS and event wiring, not real iOS compositor timing.
      document.body.style.transform = shiftLayout ? `translateY(${-viewport.offsetTop}px)` : "none";
      (event === "pageshow" ? window : viewport).dispatchEvent(new Event(event));
    };
    window.measureTestShell = () => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      };
      return {
        shell: rect(".app-shell"), header: rect(".app-header"), footer: rect(".bottom-nav"),
        mainScroll: document.querySelector(".app-main").scrollTop,
        enabled: document.documentElement.classList.contains("ios-standalone-viewport"),
        keyboard: document.documentElement.classList.contains("entry-keyboard-active")
      };
    };
  }, standalone);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  return { context, page };
}

function verifyBounds(state, height, gap, label) {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.75, `${label}: ${actual} != ${expected}`);
  assert.equal(state.enabled, true, label);
  near(state.shell.top, 0);
  near(state.shell.height, height);
  near(state.shell.bottom, height);
  near(state.header.top, gap);
  near(state.footer.bottom, height - gap);
}

async function viewportEvent(page, values, event = "resize") {
  return page.evaluate(({ values, event }) => {
    window.setTestViewport(values, event);
    // Measure in the same task: an 80 ms debounce must fail this assertion.
    return window.measureTestShell();
  }, { values, event });
}

async function verifyPanelGestures(page, enabled) {
  const result = await page.evaluate(() => {
    const touchActions = [".app-header", ".bottom-nav"].map((selector) => getComputedStyle(document.querySelector(selector)).touchAction);
    const events = [];
    // Child targets exercise bubbling to the panels.
    for (const selector of ["#settings-button", ".bottom-nav .nav-label"]) {
      const target = document.querySelector(selector);
      for (const type of ["touchstart", "touchmove", "touchend"]) {
        const touch = new Touch({ identifier: 1, target, clientX: 100, clientY: type === "touchstart" ? 400 : 30 });
        const touches = type === "touchend" ? [] : [touch];
        const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [touch] });
        target.dispatchEvent(event);
        events.push({ selector, type, prevented: event.defaultPrevented });
      }
    }
    return { touchActions, events };
  });
  assert.deepEqual(result.touchActions, [enabled ? "none" : "auto", enabled ? "none" : "auto"]);
  for (const { selector, type, prevented } of result.events) {
    assert.equal(prevented, enabled && type === "touchmove", `${selector} ${type}`);
  }
}

async function contentGesture(page, { top = 0, deltaY = 40, deltaX = 0, selector = ".app-content" } = {}) {
  const result = await page.evaluate(({ top, deltaY, deltaX, selector }) => {
    const main = document.querySelector(".app-main");
    main.scrollTop = top === "bottom" ? main.scrollHeight - main.clientHeight : top;
    const target = document.querySelector(selector);
    const prevented = [];
    for (const type of ["touchstart", "touchmove", "touchend"]) {
      const touch = new Touch({ identifier: 1, target, clientX: 150 + (type === "touchstart" ? 0 : deltaX), clientY: 300 + (type === "touchstart" ? 0 : deltaY) });
      const touches = type === "touchend" ? [] : [touch];
      const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [touch] });
      target.dispatchEvent(event);
      prevented.push(event.defaultPrevented);
    }
    return prevented;
  }, { top, deltaY, deltaX, selector });
  assert.equal(result[0], false, "Touches must still start normally");
  assert.equal(result[2], false, "Touches must still end normally");
  return result[1];
}

async function verifyContentMode(page, fits, enabled = true) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const state = await page.locator(".app-main").evaluate((main) => ({
    fits: main.scrollHeight - main.clientHeight <= 1,
    locked: main.classList.contains("content-fits"),
    rootFits: document.documentElement.classList.contains("app-content-fits"),
    height: main.clientHeight, contentHeight: main.scrollHeight,
    overflow: getComputedStyle(main).overflowY,
    touchAction: getComputedStyle(main).touchAction,
    overscroll: getComputedStyle(main).overscrollBehaviorY,
    scrollbars: [document.documentElement, document.body, main].map((element) => ({
      standard: getComputedStyle(element).scrollbarWidth,
      webkit: getComputedStyle(element, "::-webkit-scrollbar").display
    })),
    dialogScrollbar: getComputedStyle(document.querySelector(".entry-form-content"), "::-webkit-scrollbar").display
  }));
  assert.equal(state.fits, fits, JSON.stringify(state));
  assert.equal(state.locked, fits && enabled, JSON.stringify(state));
  assert.equal(state.rootFits, fits && enabled, JSON.stringify(state));
  assert.equal(state.overflow, enabled && fits ? "hidden" : "auto");
  assert.equal(state.touchAction, enabled && fits ? "pan-x" : "auto");
  assert.equal(state.overscroll, enabled ? "none" : "contain");
  for (const scrollbar of state.scrollbars) {
    assert.equal(scrollbar.standard, enabled && fits ? "none" : "auto");
    assert.equal(scrollbar.webkit === "none", enabled && fits, "Legacy scrollbar hiding must follow content size after rotation and navigation");
  }
  assert.notEqual(state.dialogScrollbar, "none", "Dialogs keep their own scrollbar");
}

async function touchDrag(page, start, end) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    for (let step = 1; step <= 10; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
        x: start.x + (end.x - start.x) * step / 10,
        y: start.y + (end.y - start.y) * step / 10
      }] });
      await page.waitForTimeout(20);
    }
    // Hold before release so momentum cannot affect the following checks.
    await page.waitForTimeout(300);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function swipeContent(page, { x = 16, reverse = false } = {}) {
  const { height } = await page.locator(".app-main").boundingBox();
  const start = { x, y: height * (reverse ? 0.4 : 0.7) };
  const end = { x, y: height * (reverse ? 0.7 : 0.4) };
  assert.equal(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".app-main")), start), true);
  await touchDrag(page, start, end);
}

async function verifyHorizontalControls(page) {
  // Exercise the app's real control types inside a fitting screen. Absolute
  // placement keeps the fixture from changing the vertical overflow mode.
  await page.locator(".app-content").evaluate((content) => {
    const fixture = document.createElement("div");
    fixture.id = "test-horizontal-controls";
    fixture.style.cssText = "position:absolute;top:180px;left:24px;right:24px";
    fixture.innerHTML = '<div class="filter-scroll" style="display:block;overflow-x:auto"><div style="width:900px;height:48px"><button type="button">Filter</button></div></div><div class="unified-range-control"><input type="range" min="0" max="100" value="50"></div>';
    content.append(fixture);
  });
  try {
    await verifyContentMode(page, true);
    const filter = "#test-horizontal-controls .filter-scroll";
    const range = "#test-horizontal-controls input";
    for (const selector of [`${filter} button`, range]) {
      assert.equal(await contentGesture(page, { selector, deltaX: 40, deltaY: 2 }), false, "Real horizontal controls must accept sideways movement");
      assert.equal(await contentGesture(page, { selector, deltaY: 40 }), true, "Controls must not enable vertical dragging on a short screen");
    }
    const filterBox = await page.locator(filter).boundingBox();
    await touchDrag(page,
      { x: filterBox.x + filterBox.width * 0.8, y: filterBox.y + 24 },
      { x: filterBox.x + filterBox.width * 0.2, y: filterBox.y + 24 });
    assert.ok(await page.locator(filter).evaluate((element) => element.scrollLeft > 50), "The filter strip must scroll with native touch events");
    const rangeBox = await page.locator(range).boundingBox();
    await touchDrag(page,
      { x: rangeBox.x + rangeBox.width * 0.5, y: rangeBox.y + rangeBox.height / 2 },
      { x: rangeBox.x + rangeBox.width * 0.8, y: rangeBox.y + rangeBox.height / 2 });
    assert.ok(Number(await page.locator(range).inputValue()) > 65, "A native touch drag must change the slider value");
    await page.locator(range).evaluate((element) => { element.disabled = true; });
    assert.equal(await contentGesture(page, { selector: range, deltaX: 40, deltaY: 2 }), true, "Disabled sliders must not bypass the lock");
    await page.locator(filter).evaluate((element) => { element.style.overflowX = "hidden"; });
    assert.equal(await contentGesture(page, { selector: `${filter} button`, deltaX: 40, deltaY: 2 }), true, "Clipped filters must not bypass the lock");
    await page.locator(filter).evaluate((element) => {
      element.style.overflowX = "auto";
      element.firstElementChild.style.width = "100%";
    });
    assert.equal(await contentGesture(page, { selector: `${filter} button`, deltaX: 40, deltaY: 2 }), true, "A filter strip that fits horizontally must not bypass the lock");
  } finally {
    await page.locator("#test-horizontal-controls").evaluate((element) => element.remove());
  }
}

async function verifyContentSwipe(page) {
  await page.locator(".app-main").evaluate((main) => { main.scrollTop = 0; });
  await swipeContent(page);
  const state = await page.locator(".app-main").evaluate((main) => ({
    top: main.scrollTop, height: main.clientHeight, contentHeight: main.scrollHeight,
    touchAction: getComputedStyle(main).touchAction, overflow: getComputedStyle(main).overflowY
  }));
  assert.ok(state.top > 50, `Content must still scroll with a native touch gesture: ${JSON.stringify(state)}`);
}

async function verifyShortContent(page, gap) {
  // Controlled content size: it fits in portrait but needs real scrolling in
  // landscape, even when the directory cards reflow into several columns.
  await page.locator("#directories-content").evaluate((content) => {
    const main = document.querySelector(".app-main");
    const padding = parseFloat(getComputedStyle(document.querySelector(".app-content")).paddingBottom);
    const top = content.getBoundingClientRect().top - main.getBoundingClientRect().top;
    content.style.minHeight = `${Math.floor(main.clientHeight - top - padding - 24)}px`;
  });
  await verifyContentMode(page, true);
  for (const [deltaX, deltaY] of [[0, -40], [0, 40], [40, 2], [-40, 0], [40, 40], [0, 0]]) {
    assert.equal(await contentGesture(page, { deltaX, deltaY }), true, "Short screens must cancel the first move in every direction outside horizontal controls");
  }
  await verifyHorizontalControls(page);
  // A list that fits in portrait needs scrolling in landscape, and must lock
  // again after returning. This also exercises the content ResizeObserver.
  await page.setViewportSize({ width: 667, height: 375 });
  await viewportEvent(page, { width: 667, height: 375, offsetTop: 0 });
  await verifyContentMode(page, false);
  await verifyContentSwipe(page);
  await page.setViewportSize({ width: 375, height: 667 });
  verifyBounds(await viewportEvent(page, { width: 375, height: 647, offsetTop: 20 }), 647, gap, "Short content after rotation");
  await verifyContentMode(page, true);
  for (const [deltaX, deltaY] of [[0, -40], [0, 40], [40, 2], [-40, 0], [40, 40], [0, 0]]) {
    assert.equal(await contentGesture(page, { deltaX, deltaY }), true, "The first-move lock must survive rotation");
  }
  for (const x of [150, 373]) {
    for (const reverse of [false, true]) await swipeContent(page, { x, reverse });
  }
  assert.equal(await page.locator(".app-main").evaluate((main) => main.scrollTop), 0);
  verifyBounds(await page.evaluate(() => window.measureTestShell()), 647, gap, "Short content after central and right-edge drags");
  await page.locator("#directories-content").evaluate((content) => { content.style.removeProperty("min-height"); });
  await page.locator(".directory-choice").first().tap();
  await page.locator("#directories-back").tap();
  await verifyContentMode(page, true);
}

async function verifyDiagnosticReport(page) {
  const report = await page.evaluate(() => {
    window.testDiagnostics.stop();
    return window.testDiagnostics.report();
  });
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.errors, 0);
  assert.equal(report.environment.cssSupport.webkitScrollbarSelector, true);
  assert.deepEqual(report.probeImpact.beforeInsertion, report.probeImpact.afterInsertion);
  assert.deepEqual(report.probeImpact.beforeRemoval, report.probeImpact.afterRemoval);
  const short = report.samples.find((sample) => sample.layout.main.classes["content-fits"]);
  assert.ok(short, "A recording must capture the short-screen hiding state");
  assert.equal(short.document.root.classes["app-content-fits"], true);
  assert.equal(short.document.root.classes["ios-standalone-viewport"], true);
  for (const metric of [short.document.root, short.document.body, short.layout.main]) {
    assert.equal(metric.scrollbar.webkitScrollbar.readable, true);
    assert.equal(metric.scrollbar.webkitScrollbar.display, "none");
    assert.equal(metric.scrollbar.webkitScrollbarThumb.readable, true);
    assert.equal(typeof metric.touchAction, "string");
  }
  assert.equal(short.layout.main.touchAction, "pan-x");
  const long = report.samples.find((sample) => !sample.layout.main.classes["content-fits"] && sample.layout.main.scrollHeight > sample.layout.main.clientHeight);
  assert.ok(long, "A recording must capture the return to a scrollable list");
  assert.equal(long.document.root.classes["app-content-fits"], false);
  assert.notEqual(long.layout.main.scrollbar.webkitScrollbar.display, "none");
  const events = report.samples.flatMap((sample) => sample.inputEvents);
  assert.ok(events.some((event) => event.type === "touchmove" && event.target.surface === "main" && event.cancelable && event.defaultPreventedAtCapture === false && event.defaultPreventedAfterDispatch === true), "Application cancellation must be observed after the capture phase");
  assert.ok(events.some((event) => event.type === "touchmove" && event.target.surface === "main" && event.isTrusted && event.defaultPreventedAfterDispatch === false), "Native content scrolling must be reported as allowed");
  const stopped = events.find((event) => event.type === "wheel");
  assert.equal(stopped.defaultPreventedAtCapture, false);
  assert.equal(stopped.defaultPreventedAfterDispatch, true, "Stopping propagation must not hide cancellation from the logger");
}

try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const { context, page } = await createPage();
  await page.evaluate(async () => {
    const { createLayoutDiagnostics } = await import("./js/layout-diagnostics.js");
    window.testDiagnostics = createLayoutDiagnostics();
  });
  for (const interfaceName of ["classic", "modern"]) {
    await page.evaluate((value) => { document.documentElement.dataset.interface = value; }, interfaceName);
    await page.evaluate(() => {
      window.testDiagnostics.start();
      const main = document.querySelector(".app-main");
      main.addEventListener("wheel", (event) => { event.preventDefault(); event.stopPropagation(); }, { once: true, passive: false });
      main.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 }));
    });
    const gap = interfaceName === "modern" ? 12 : 0;
    for (const [width, layoutHeight, height, offsetTop] of [[375, 647, 647, 0], [667, 375, 375, 0], [375, 667, 667, 0], [375, 667, 647, 20]]) {
      await page.setViewportSize({ width, height: layoutHeight });
      verifyBounds(await viewportEvent(page, { width, height, offsetTop }), height, gap, `${interfaceName} rotation`);
    }
    await verifyPanelGestures(page, true);
    for (const view of ["diary", "stats", "medications", "directories"]) {
      await page.locator(`[data-view="${view}"]`).tap();
      await page.waitForFunction((view) => document.querySelector(`[data-view="${view}"]`).classList.contains("active"), view);
      for (const offsetTop of [20, 9, 0, 8, 20, 14, 0]) {
        verifyBounds(await viewportEvent(page, { height: 647, offsetTop }, "scroll"), 647, gap, `${interfaceName} ${view} offset ${offsetTop}`);
      }
    }
    await verifyShortContent(page, gap);
    await page.locator("#settings-button").tap();
    await page.waitForTimeout(250);
    await verifyContentMode(page, false);
    for (const [top, deltaY, blocked] of [[0, 40, true], [0, -40, false], [120, 40, false], [120, -40, false], ["bottom", -40, true], ["bottom", 40, false]]) {
      assert.equal(await contentGesture(page, { top, deltaY }), blocked, `Long content: position ${top}, movement ${deltaY}`);
    }
    await verifyContentSwipe(page);
    const scrollBefore = await page.evaluate(() => {
      const main = document.querySelector(".app-main");
      main.scrollTop = 120;
      return main.scrollTop;
    });
    assert.equal(scrollBefore, 120);
    for (const offsetTop of [20, 0, 9, 20]) {
      const state = await viewportEvent(page, { offsetTop }, "scroll");
      verifyBounds(state, 647, gap, `${interfaceName} keep inner scroll`);
      assert.equal(state.mainScroll, scrollBefore);
    }
    await page.waitForTimeout(150);
    assert.equal((await page.evaluate(() => window.measureTestShell())).mainScroll, scrollBefore);
    verifyBounds(await viewportEvent(page, { offsetTop: 0 }, "pageshow"), 647, gap, `${interfaceName} resume`);

    await page.locator('[data-view="diary"]').click();
    await page.locator("#add-button").click();
    await page.locator("#choose-headache").click();
    await page.locator("#headache-comment").focus();
    const withKeyboard = await viewportEvent(page, { height: 320, offsetTop: 0 });
    assert.equal(withKeyboard.keyboard, true);
    verifyBounds(withKeyboard, 647, gap, `${interfaceName} frozen keyboard background`);
    assert.equal(await page.locator("#headache-dialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#headache-comment").evaluate((field) => document.activeElement === field), true);
    await page.locator("#headache-dialog .close-button").click();
    await page.waitForTimeout(30);
    const restored = await viewportEvent(page, { height: 647, offsetTop: 20 });
    assert.equal(restored.keyboard, false);
    verifyBounds(restored, 647, gap, `${interfaceName} keyboard close`);
    await verifyDiagnosticReport(page);
    console.log(`PASS ${interfaceName}: rotation, four screens, panel drag guard, all short-screen movements locked, native horizontal controls, long content swipe, touch taps, intermediate offsets, preserved inner scroll, resume, keyboard`);
    console.log(`PASS ${interfaceName}: diagnostic classes, scrollbar styles and final cancellation, including stopped propagation and native touch events`);
  }
  await context.close();
  for (const [label, userAgent, standalone] of [["iOS browser", iosAgent, false], ["Android PWA", "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", true]]) {
    const { context, page } = await createPage(userAgent, standalone);
    await page.setViewportSize({ width: 375, height: 667 });
    const state = await page.evaluate(() => {
      window.setTestViewport({ height: 647, offsetTop: 20 }, "resize", false);
      return window.measureTestShell();
    });
    assert.equal(state.enabled, false, label);
    assert.equal(state.shell.height, 667, label);
    assert.equal(state.shell.top, 0, label);
    await verifyPanelGestures(page, false);
    await page.locator('[data-view="directories"]').tap();
    await verifyContentMode(page, true, false);
    assert.equal(await contentGesture(page), false, label);
    await context.close();
    console.log(`PASS ${label}: normal shell sizing retained`);
  }
  const offlineContext = await browser.newContext({ serviceWorkers: "allow" });
  const offlinePage = await offlineContext.newPage();
  offlinePage.on("pageerror", (error) => errors.push(error.message));
  await offlinePage.goto(`http://127.0.0.1:${server.address().port}/`);
  await offlinePage.waitForFunction(() => navigator.serviceWorker.controller !== null);
  assert.equal(await offlinePage.evaluate(async () => Boolean(await caches.match(new URL("./js/viewport.js", location.href)))), true);
  await offlineContext.setOffline(true);
  await offlinePage.reload();
  await offlinePage.waitForFunction(() => /^v\d+\.\d+\.\d+$/.test(document.querySelector("#app-version").textContent));
  await offlinePage.locator("#settings-button").click();
  await offlinePage.locator("#layout-diagnostics-toggle").click();
  assert.match(await offlinePage.locator("#layout-diagnostics-status").textContent(), /Идёт запись/);
  await offlineContext.close();
  console.log("PASS offline startup: new viewport module is cached and the app works after reload without a network");
  assert.deepEqual(errors, []);
  console.log("Synthetic viewport regression checks passed in Chromium; physical iOS validation is still required.");
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

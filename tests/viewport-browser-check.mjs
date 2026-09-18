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
    const touchActions = [".app-header", ".bottom-nav", ".app-main"].map((selector) => getComputedStyle(document.querySelector(selector)).touchAction);
    const events = [];
    // Child targets exercise bubbling to the panels. A content gesture keeps
    // its original target even when the finger moves over the header.
    for (const selector of ["#settings-button", ".bottom-nav .nav-label", ".app-main"]) {
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
  assert.deepEqual(result.touchActions, [enabled ? "none" : "auto", enabled ? "none" : "auto", "auto"]);
  for (const { selector, type, prevented } of result.events) {
    assert.equal(prevented, enabled && selector !== ".app-main" && type === "touchmove", `${selector} ${type}`);
  }
}

async function verifyContentSwipe(page) {
  await page.locator(".app-main").evaluate((main) => { main.scrollTop = 0; });
  assert.equal(await page.evaluate(() => Boolean(document.elementFromPoint(16, 450)?.closest(".app-main"))), true);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 16, y: 450 }] });
    for (let step = 1; step <= 10; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 16, y: 450 - step * 20 }] });
      await page.waitForTimeout(20);
    }
    // Hold before release so momentum cannot affect the following checks.
    await page.waitForTimeout(300);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.ok(await page.locator(".app-main").evaluate((main) => main.scrollTop > 50), "Content must still scroll with a native touch gesture");
  } finally {
    await session.detach();
  }
}

try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const { context, page } = await createPage();
  for (const interfaceName of ["classic", "modern"]) {
    await page.evaluate((value) => { document.documentElement.dataset.interface = value; }, interfaceName);
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
    await page.locator("#settings-button").tap();
    await page.waitForTimeout(250);
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
    console.log(`PASS ${interfaceName}: rotation, four screens, panel drag guard, touch taps and content swipe, intermediate offsets, preserved inner scroll, resume, keyboard`);
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

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const browserCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const devices = [
  { name: "iPhone 8", portrait: [375, 667], dpr: 2, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  { name: "iPhone 13", portrait: [390, 844], dpr: 3, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  { name: "Redmi Note 11 4G", portrait: [393, 873], dpr: 2.75, userAgent: "Mozilla/5.0 (Linux; Android 13; 2201117TG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" }
];
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".md", "text/markdown; charset=utf-8"], [".png", "image/png"]
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function findBrowser() {
  for (const candidate of browserCandidates) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* try the next installed browser */ }
  }
  throw new Error("Microsoft Edge или Google Chrome не найден.");
}

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const target = normalize(resolve(root, relative));
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Недопустимый путь");
      const body = await readFile(target);
      response.writeHead(200, { "content-type": mimeTypes.get(extname(target)) || "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function closeEnough(first, second, tolerance = 0.75) {
  return Math.abs(first - second) <= tolerance;
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  await page.waitForTimeout(30);
}

async function waitForShellViewport(page) {
  await page.waitForFunction(() => {
    const shell = document.querySelector(".app-shell")?.getBoundingClientRect();
    const viewport = visualViewport;
    if (!shell || !viewport || document.querySelector("dialog.entry-form-dialog.entry-keyboard-open[open]")) return false;
    const close = (first, second) => Math.abs(first - second) <= .75;
    return close(shell.top, viewport.offsetTop) && close(shell.left, viewport.offsetLeft) &&
      close(shell.width, viewport.width) && close(shell.height, viewport.height);
  }, null, { timeout: 2000 });
}

async function waitForDialogMotion(page, selector) {
  await page.locator(selector).evaluate(async (dialog) => {
    if (typeof dialog.getAnimations !== "function") return;
    await Promise.allSettled(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  await settle(page);
}

async function measure(page) {
  await waitForShellViewport(page);
  return page.evaluate(() => {
    const shell = document.querySelector(".app-shell").getBoundingClientRect();
    const header = document.querySelector(".app-header").getBoundingClientRect();
    const footer = document.querySelector(".bottom-nav").getBoundingClientRect();
    const main = document.querySelector(".app-main");
    return {
      header: { top: header.top, bottom: header.bottom },
      footer: { top: footer.top, bottom: footer.bottom },
      shell: { top: shell.top, left: shell.left, right: shell.right, bottom: shell.bottom, width: shell.width, height: shell.height },
      visualViewport: { top: visualViewport?.offsetTop || 0, left: visualViewport?.offsetLeft || 0, width: visualViewport?.width || innerWidth, height: visualViewport?.height || innerHeight },
      scrollTop: main.scrollTop,
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
      rootScroll: document.scrollingElement.scrollTop,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      viewport: { width: innerWidth, height: innerHeight },
      interface: document.documentElement.dataset.interface,
      theme: document.documentElement.dataset.theme,
      colorScheme: getComputedStyle(document.documentElement).colorScheme
    };
  });
}

async function verifyStableScroll(page, label) {
  await page.evaluate(() => { document.querySelector(".app-main").scrollTop = 0; });
  await settle(page);
  let start = await measure(page);
  if (start.scrollHeight <= start.clientHeight) {
    await page.evaluate(() => {
      let probe = document.querySelector("[data-mobile-scroll-probe]");
      if (!probe) {
        probe = document.createElement("div");
        probe.dataset.mobileScrollProbe = "";
        probe.setAttribute("aria-hidden", "true");
        document.querySelector(".app-content").append(probe);
      }
      probe.style.height = `${document.querySelector(".app-main").clientHeight}px`;
    });
    await settle(page);
    start = await measure(page);
  }
  const target = Math.min(start.scrollHeight - start.clientHeight, Math.max(80, Math.round(start.clientHeight * 0.45)));
  assert(target > 0, `${label}: экран не имеет проверяемой прокрутки`);
  await page.evaluate((top) => { document.querySelector(".app-main").scrollTop = top; }, target);
  await settle(page);
  const down = await measure(page);
  await page.evaluate((top) => { document.querySelector(".app-main").scrollTop = top; }, Math.max(1, Math.round(target / 3)));
  await settle(page);
  const up = await measure(page);
  for (const [phase, current] of [["вниз", down], ["вверх", up]]) {
    assert(closeEnough(start.header.top, current.header.top) && closeEnough(start.header.bottom, current.header.bottom), `${label}: шапка сдвинулась при прокрутке ${phase}`);
    assert(closeEnough(start.footer.top, current.footer.top) && closeEnough(start.footer.bottom, current.footer.bottom), `${label}: подвал сдвинулся при прокрутке ${phase}`);
    assert(current.rootScroll === 0, `${label}: прокрутился корневой документ`);
    assert(current.htmlOverflow === "hidden" && current.bodyOverflow === "hidden", `${label}: корневая прокрутка разблокирована`);
    assert(closeEnough(current.shell.top, current.visualViewport.top) && closeEnough(current.shell.left, current.visualViewport.left) && closeEnough(current.shell.width, current.visualViewport.width) && closeEnough(current.shell.height, current.visualViewport.height), `${label}: оболочка не совпадает с visual viewport`);
    assert(current.header.top >= current.shell.top - 0.75 && current.footer.bottom <= current.shell.bottom + 0.75, `${label}: панели вышли за viewport`);
  }
  return start;
}

async function verifyClassicHeader(page, label) {
  const state = await page.evaluate(() => {
    const header = document.querySelector(".app-header").getBoundingClientRect();
    const shell = document.querySelector(".app-shell").getBoundingClientRect();
    const brandIcon = document.querySelector(".brand-icon-container").getBoundingClientRect();
    const settings = document.querySelector("#settings-button").getBoundingClientRect();
    return {
      interfaceName: document.documentElement.dataset.interface,
      header: { top: header.top, left: header.left, right: header.right, height: header.height },
      shell: { top: shell.top, left: shell.left, right: shell.right },
      shellSafeTop: Number.parseFloat(getComputedStyle(document.querySelector(".app-shell")).paddingTop),
      brandIcon: { width: brandIcon.width, height: brandIcon.height },
      settings: { width: settings.width, height: settings.height },
      titleSize: Number.parseFloat(getComputedStyle(document.querySelector(".app-header h1")).fontSize),
      eyebrowSize: Number.parseFloat(getComputedStyle(document.querySelector(".app-header .eyebrow")).fontSize)
    };
  });
  assert(state.interfaceName === "classic", `${label}: классический интерфейс не включён`);
  assert(closeEnough(state.header.top, state.shell.top + state.shellSafeTop), `${label}: шапка не закреплена у верхнего края`);
  assert(closeEnough(state.header.left, state.shell.left) && closeEnough(state.header.right, state.shell.right), `${label}: шапка не занимает верхний край по ширине`);
  assert(closeEnough(state.header.height, 72), `${label}: высота шапки изменилась`);
  assert(closeEnough(state.brandIcon.width, 52) && closeEnough(state.brandIcon.height, 52), `${label}: логотип шапки стал компактнее`);
  assert(closeEnough(state.settings.width, 52) && closeEnough(state.settings.height, 52), `${label}: кнопка настроек стала компактнее`);
  assert(closeEnough(state.titleSize, 21) && closeEnough(state.eyebrowSize, 11), `${label}: текст шапки стал компактнее`);
}

async function verifyDialogState(page, dialogSelector, expectedOpen, label) {
  const state = await page.evaluate(({ selector, open }) => {
    const dialog = document.querySelector(selector);
    const main = document.querySelector(".app-main");
    return {
      matches: dialog.open === open,
      modalOpen: document.documentElement.classList.contains("modal-open"),
      mainOverflow: getComputedStyle(main).overflowY,
      surfacesInert: [document.querySelector(".app-header"), main, document.querySelector(".bottom-nav")].every((node) => node.inert),
      rootScroll: document.scrollingElement.scrollTop
    };
  }, { selector: dialogSelector, open: expectedOpen });
  assert(state.matches, `${label}: неверное состояние ${dialogSelector}`);
  assert(state.modalOpen === expectedOpen, `${label}: класс modal-open не синхронизирован`);
  assert(state.surfacesInert === expectedOpen, `${label}: inert фоновых областей не синхронизирован`);
  if (expectedOpen) assert(state.mainOverflow === "hidden", `${label}: фоновая прокрутка не заблокирована`);
  assert(state.rootScroll === 0, `${label}: прокрутился корневой документ`);
}

async function verifyModalFlow(page, label) {
  await page.evaluate(() => {
    const main = document.querySelector(".app-main");
    main.scrollTop = Math.min(40, Math.max(0, main.scrollHeight - main.clientHeight));
  });
  await settle(page);
  const backgroundScroll = await page.locator(".app-main").evaluate((node) => node.scrollTop);

  await page.locator("#add-button").evaluate((button) => button.click());
  await page.locator("#entry-type-dialog[open]").waitFor({ state: "visible" });
  await waitForDialogMotion(page, "#entry-type-dialog");
  await verifyDialogState(page, "#entry-type-dialog", true, `${label} выбор типа`);
  await page.locator("#entry-type-dialog .close-button").click();
  await page.waitForFunction(() => !document.querySelector("#entry-type-dialog").open);
  await verifyDialogState(page, "#entry-type-dialog", false, `${label} закрытие выбора типа`);

  await page.locator("#add-button").evaluate((button) => button.click());
  await page.locator("#choose-headache").click();
  await page.locator("#headache-dialog[open]").waitFor({ state: "visible" });
  await waitForDialogMotion(page, "#headache-dialog");
  await verifyDialogState(page, "#headache-dialog", true, `${label} форма боли`);
  const lockedBackgroundScroll = await page.locator(".app-main").evaluate((node) => node.scrollTop);

  const initial = await page.evaluate(() => {
    const dialog = document.querySelector("#headache-dialog");
    const shell = document.querySelector(".app-shell").getBoundingClientRect();
    const content = dialog.querySelector(".entry-form-content");
    const header = dialog.querySelector(".dialog-header").getBoundingClientRect();
    const actions = dialog.querySelector(".dialog-actions").getBoundingClientRect();
    return { shell: { top: shell.top, left: shell.left, width: shell.width, height: shell.height }, header: { top: header.top, bottom: header.bottom }, actions: { top: actions.top, bottom: actions.bottom }, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight };
  });
  assert(initial.scrollHeight > initial.clientHeight, `${label}: содержимое длинной формы не прокручивается`);
  const scrollTarget = Math.min(initial.scrollHeight - initial.clientHeight, Math.max(80, Math.round(initial.clientHeight * 0.7)));
  await page.locator("#headache-dialog .entry-form-content").evaluate((node, top) => { node.scrollTop = top; }, scrollTarget);
  await settle(page);
  const scrolled = await page.evaluate(() => {
    const dialog = document.querySelector("#headache-dialog");
    const content = dialog.querySelector(".entry-form-content");
    const header = dialog.querySelector(".dialog-header").getBoundingClientRect();
    const actions = dialog.querySelector(".dialog-actions").getBoundingClientRect();
    return { open: dialog.open, scrollTop: content.scrollTop, header: { top: header.top, bottom: header.bottom }, actions: { top: actions.top, bottom: actions.bottom }, backgroundScroll: document.querySelector(".app-main").scrollTop };
  });
  assert(scrolled.open && scrolled.scrollTop > 0, `${label}: прокрутка модальной формы не сработала`);
  assert(
    closeEnough(initial.header.top, scrolled.header.top) && closeEnough(initial.actions.bottom, scrolled.actions.bottom),
    `${label}: фиксированные панели формы сдвинулись при прокрутке ` +
      `(header ${initial.header.top.toFixed(2)} → ${scrolled.header.top.toFixed(2)}, ` +
      `actions ${initial.actions.bottom.toFixed(2)} → ${scrolled.actions.bottom.toFixed(2)})`
  );
  assert(scrolled.backgroundScroll === lockedBackgroundScroll, `${label}: вместе с модальным окном прокрутился фон (${lockedBackgroundScroll} → ${scrolled.backgroundScroll})`);

  const viewport = page.viewportSize();
  await page.locator("#headache-comment").focus();
  await page.waitForTimeout(260);
  const keyboardHeight = viewport.width < viewport.height
    ? Math.max(viewport.width + 20, Math.round(viewport.height * 0.64))
    : Math.max(220, Math.round(viewport.height * 0.64));
  await page.setViewportSize({ width: viewport.width, height: keyboardHeight });
  await page.waitForTimeout(720);
  const keyboardOpen = await page.evaluate(() => {
    const dialog = document.querySelector("#headache-dialog");
    const content = dialog.querySelector(".entry-form-content");
    const focused = document.querySelector("#headache-comment").getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const shell = document.querySelector(".app-shell").getBoundingClientRect();
    const actions = dialog.querySelector(".dialog-actions").getBoundingClientRect();
    return {
      active: document.activeElement?.id,
      dialogOpen: dialog.open,
      shell: { top: shell.top, left: shell.left, width: shell.width, height: shell.height },
      dialogTop: dialogRect.top,
      dialogBottom: dialogRect.bottom,
      actionsBottom: actions.bottom,
      focusedTop: focused.top,
      focusedBottom: focused.bottom,
      contentTop: contentRect.top,
      contentBottom: contentRect.bottom,
      contentScrollTop: content.scrollTop,
      contentScrollMax: content.scrollHeight - content.clientHeight,
      visualHeight: visualViewport?.height || innerHeight,
      cssVisualHeight: getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height").trim(),
      keyboardClass: dialog.classList.contains("entry-keyboard-open")
    };
  });
  const keyboardIssues = [];
  if (!keyboardOpen.keyboardClass) keyboardIssues.push("компактный режим клавиатуры не включился");
  if (!closeEnough(initial.shell.top, keyboardOpen.shell.top) || !closeEnough(initial.shell.left, keyboardOpen.shell.left) || !closeEnough(initial.shell.width, keyboardOpen.shell.width) || !closeEnough(initial.shell.height, keyboardOpen.shell.height)) keyboardIssues.push("основная оболочка изменила геометрию при открытии клавиатуры");
  if (keyboardOpen.active !== "headache-comment" || !keyboardOpen.dialogOpen) keyboardIssues.push("фокус потерян при открытии клавиатуры");
  if (keyboardOpen.dialogTop < -0.75 || keyboardOpen.dialogBottom > keyboardOpen.visualHeight + 0.75) keyboardIssues.push("окно вышло за visual viewport при открытой клавиатуре");
  if (keyboardOpen.actionsBottom > keyboardOpen.visualHeight + 0.75) keyboardIssues.push("нижние действия перекрыты клавиатурой");
  if (keyboardOpen.focusedTop < keyboardOpen.contentTop - 0.75 || keyboardOpen.focusedBottom > keyboardOpen.contentBottom + 0.75) {
    keyboardIssues.push(
      "активное поле не прокручено в видимую область " +
      `(поле ${keyboardOpen.focusedTop.toFixed(2)}…${keyboardOpen.focusedBottom.toFixed(2)}, ` +
      `контент ${keyboardOpen.contentTop.toFixed(2)}…${keyboardOpen.contentBottom.toFixed(2)}, ` +
      `scroll ${keyboardOpen.contentScrollTop.toFixed(2)}/${keyboardOpen.contentScrollMax.toFixed(2)}, viewport ${keyboardOpen.visualHeight.toFixed(2)})`
    );
  }
  if (Number.parseFloat(keyboardOpen.cssVisualHeight) > keyboardOpen.visualHeight + 0.75) keyboardIssues.push("высота visual viewport не синхронизирована");

  for (const selector of ["#headache-start-datetime", "#body-part", "#headache-comment"]) {
    await page.locator(selector).focus();
    await page.waitForTimeout(720);
    const focusedState = await page.locator(selector).evaluate((field) => {
      const dialog = field.closest("dialog.entry-form-dialog");
      const content = dialog.querySelector(".entry-form-content").getBoundingClientRect();
      const bounds = field.getBoundingClientRect();
      return {
        active: document.activeElement === field,
        keyboardClass: dialog.classList.contains("entry-keyboard-open"),
        visible: bounds.top >= content.top - .75 && bounds.bottom <= content.bottom + .75
      };
    });
    if (!focusedState.active || !focusedState.keyboardClass || !focusedState.visible) keyboardIssues.push(`${selector} не доведено до видимой области при последовательной смене фокуса`);
  }

  await page.locator("#headache-comment").evaluate((node) => node.blur());
  await page.setViewportSize(viewport);
  await page.waitForTimeout(180);
  await waitForShellViewport(page);
  assert(await page.locator("#headache-dialog").evaluate((dialog) => dialog.open), `${label}: окно закрылось при закрытии клавиатуры`);
  assert(!await page.locator("#headache-dialog").evaluate((dialog) => dialog.classList.contains("entry-keyboard-open")), `${label}: состояние клавиатуры не очищено`);
  await page.locator("#headache-cancel").click();
  await page.waitForFunction(() => !document.querySelector("#headache-dialog").open);
  await page.waitForTimeout(200);
  await verifyDialogState(page, "#headache-dialog", false, `${label} закрытие формы`);
  const restoredScroll = await page.locator(".app-main").evaluate((node) => node.scrollTop);
  assert(restoredScroll === backgroundScroll, `${label}: позиция фоновой прокрутки не восстановилась (${backgroundScroll} → ${restoredScroll})`);
  if (keyboardIssues.length) throw new Error(`${label}: ${keyboardIssues.join("; ")}`);
}

async function verifyKeyboardOrientationFlow(page, device) {
  const [portraitWidth, portraitHeight] = device.portrait;
  await page.setViewportSize({ width: portraitWidth, height: portraitHeight });
  await settle(page);
  await page.locator('[data-interface-choice="modern"]').click();
  await settle(page);
  await page.locator('[data-view="diary"]').click();
  await settle(page);
  await page.evaluate(() => { document.querySelector(".app-main").scrollTop = 40; });
  const backgroundScroll = await page.locator(".app-main").evaluate((node) => node.scrollTop);
  await page.locator("#add-button").evaluate((button) => button.click());
  await page.locator("#choose-weight").click();
  await page.locator("#weight-dialog[open]").waitFor({ state: "visible" });
  await waitForDialogMotion(page, "#weight-dialog");
  await page.locator("#weight-value").focus();
  await page.waitForTimeout(260);
  const portraitKeyboardHeight = Math.max(portraitWidth + 20, Math.round(portraitHeight * .64));
  await page.setViewportSize({ width: portraitWidth, height: portraitKeyboardHeight });
  await page.waitForTimeout(720);
  const portraitState = await page.locator("#weight-value").evaluate((field) => {
    const dialog = field.closest("dialog.entry-form-dialog");
    const content = dialog.querySelector(".entry-form-content").getBoundingClientRect();
    const bounds = field.getBoundingClientRect();
    return { active: document.activeElement === field, keyboard: dialog.classList.contains("entry-keyboard-open"), visible: bounds.top >= content.top - .75 && bounds.bottom <= content.bottom + .75 };
  });
  assert(portraitState.active && portraitState.keyboard && portraitState.visible, `${device.name}: обычное текстовое поле не подготовлено к открытой клавиатуре`);

  const landscapeKeyboardHeight = Math.max(220, Math.round(portraitWidth * .64));
  await page.setViewportSize({ width: portraitHeight, height: landscapeKeyboardHeight });
  await page.waitForTimeout(500);
  const landscapeState = await page.evaluate(() => {
    const dialog = document.querySelector("#weight-dialog");
    const field = document.querySelector("#weight-value").getBoundingClientRect();
    const content = dialog.querySelector(".entry-form-content").getBoundingClientRect();
    const actions = dialog.querySelector(".dialog-actions").getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    const visualHeight = visualViewport?.height || innerHeight;
    return {
      landscape: matchMedia("(orientation: landscape)").matches,
      active: document.activeElement?.id === "weight-value",
      keyboard: dialog.classList.contains("entry-keyboard-open"),
      fieldVisible: field.top >= content.top - .75 && field.bottom <= content.bottom + .75,
      dialogVisible: bounds.top >= -0.75 && bounds.bottom <= visualHeight + .75,
      actionsVisible: actions.bottom <= visualHeight + .75
    };
  });
  assert(landscapeState.landscape && landscapeState.active && landscapeState.keyboard, `${device.name}: состояние клавиатуры потеряно при повороте ${JSON.stringify(landscapeState)}`);
  assert(landscapeState.fieldVisible && landscapeState.dialogVisible && landscapeState.actionsVisible, `${device.name}: форма вышла за visual viewport при повороте с клавиатурой`);

  await page.locator("#weight-dialog .dialog-actions .secondary-button").click();
  await page.waitForFunction(() => !document.querySelector("#weight-dialog").open);
  await page.waitForTimeout(200);
  assert(!await page.locator("#weight-dialog").evaluate((dialog) => dialog.classList.contains("entry-keyboard-open")), `${device.name}: состояние клавиатуры осталось после закрытия формы`);
  const restoredBackground = await page.locator(".app-main").evaluate((node) => ({ scrollTop: node.scrollTop, scrollMax: node.scrollHeight - node.clientHeight }));
  assert(restoredBackground.scrollTop === Math.min(backgroundScroll, restoredBackground.scrollMax), `${device.name}: фон прокрутился при закрытии формы с клавиатурой (${backgroundScroll} → ${restoredBackground.scrollTop}, max ${restoredBackground.scrollMax})`);
  await page.setViewportSize({ width: portraitWidth, height: portraitHeight });
  await settle(page);
}

async function main() {
  const browserPath = await findBrowser();
  const server = await startServer();
  const address = server.address();
  const failures = [];
  const chromiumBrowser = await chromium.launch({ executablePath: browserPath, headless: true });
  let webkitBrowser;
  try { webkitBrowser = await webkit.launch({ headless: true }); }
  catch { process.stderr.write("WebKit не установлен; iPhone-профили будут проверены в Chromium. Запустите `npx playwright-core install webkit` для WebKit-прогона.\n"); }
  try {
    for (const device of devices) {
      let deviceFailures = 0;
      const useWebKit = device.name.startsWith("iPhone") && webkitBrowser;
      const browser = useWebKit ? webkitBrowser : chromiumBrowser;
      const [portraitWidth, portraitHeight] = device.portrait;
      const context = await browser.newContext({
        viewport: { width: portraitWidth, height: portraitHeight },
        screen: { width: portraitWidth, height: portraitHeight },
        deviceScaleFactor: device.dpr,
        hasTouch: true,
        isMobile: true,
        userAgent: device.userAgent,
        colorScheme: "light"
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
      await page.locator("#settings-button").click();
      await page.locator('[data-settings-target="interface"]').click();
      await page.locator("#interface-view").waitFor({ state: "visible" });

      for (const orientation of ["portrait", "landscape"]) {
        const portrait = orientation === "portrait";
        await page.setViewportSize({ width: portrait ? portraitWidth : portraitHeight, height: portrait ? portraitHeight : portraitWidth });
        await settle(page);
        assert(await page.evaluate((value) => matchMedia(`(orientation: ${value})`).matches, orientation), `${device.name}: не применилась ориентация ${orientation}`);

        for (const theme of ["light", "dark"]) {
          await page.locator(`[data-theme-choice="${theme}"]`).click();
          await settle(page);
          const themed = await measure(page);
          assert(themed.theme === theme && themed.colorScheme === theme, `${device.name} ${orientation}: тема ${theme} не включилась`);

          await page.locator('[data-interface-choice="modern"]').click();
          await settle(page);
          const modernBefore = await verifyStableScroll(page, `${device.name} ${orientation} ${theme} modern`);

          await page.locator('[data-interface-choice="classic"]').click();
          await settle(page);
          await verifyClassicHeader(page, `${device.name} ${orientation} ${theme}`);
          await verifyStableScroll(page, `${device.name} ${orientation} ${theme} classic`);

          await page.locator('[data-interface-choice="modern"]').click();
          await settle(page);
          const modernAfter = await measure(page);
          assert(closeEnough(modernBefore.header.top, modernAfter.header.top) && closeEnough(modernBefore.footer.bottom, modernAfter.footer.bottom), `${device.name} ${orientation} ${theme}: панели modern изменили положение после цикла modern → classic → modern`);
        }
      }

      for (const orientation of ["portrait", "landscape"]) {
        const portrait = orientation === "portrait";
        await page.setViewportSize({ width: portrait ? portraitWidth : portraitHeight, height: portrait ? portraitHeight : portraitWidth });
        await settle(page);
        for (const interfaceName of ["classic", "modern"]) {
          await page.locator(`[data-interface-choice="${interfaceName}"]`).click();
          await settle(page);
          await page.locator('[data-view="diary"]').click();
          await settle(page);
          const modalLabel = `${device.name} ${orientation} ${interfaceName}`;
          try {
            await verifyModalFlow(page, modalLabel);
          } catch (error) {
            deviceFailures += 1;
            failures.push(error.message);
            process.stdout.write(`✗ ${error.message}\n`);
          } finally {
            await page.setViewportSize({ width: portrait ? portraitWidth : portraitHeight, height: portrait ? portraitHeight : portraitWidth });
            await page.evaluate(() => {
              for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
            });
            await settle(page);
          }
          await page.locator("#settings-button").click();
          await page.locator('[data-settings-target="interface"]').click();
          await page.locator("#interface-view").waitFor({ state: "visible" });
        }
      }

      await verifyKeyboardOrientationFlow(page, device);

      await page.setViewportSize({ width: portraitWidth, height: portraitHeight });
      await settle(page);
      const returned = await measure(page);
      assert(returned.viewport.width === portraitWidth && returned.viewport.height === portraitHeight, `${device.name}: портретная ориентация не восстановилась`);
      await context.close();
      process.stdout.write(`${deviceFailures ? "△" : "✓"} ${device.name} (${useWebKit ? "WebKit" : "Chromium"}): ${deviceFailures ? `${deviceFailures} ошибок` : "все проверки пройдены"}\n`);
    }
  } finally {
    await webkitBrowser?.close();
    await chromiumBrowser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  if (failures.length) throw new Error(`Мобильная проверка завершилась с ошибками (${failures.length}):\n- ${failures.join("\n- ")}`);
}

await main();

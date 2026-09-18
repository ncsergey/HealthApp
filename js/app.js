import { STORES, countImportConflicts, deleteMedicationCourse, deleteRecord, getAllData, mergeData, openDatabase, replaceAllData, saveDirectoryItem, saveProfile, saveRecord } from "./db.js";
import { formatDayLabel, formatDuration, formatTime, getDateKey, getMoscowFields, getPeriodBounds, isFuture, moscowDateTimeInputToIso } from "./datetime.js";
import { drawTimeChart } from "./charts.js";
import { exportCsv, exportJson } from "./export.js";
import { parseBackupFile } from "./import.js";
import { filterDataForPeriod, glucoseStats, painStats, pressureStats, pulseStats, stepsStats, temperatureStats, weightStats } from "./statistics.js";
import { ageOnDate, calculateBmi, evaluateBmi, evaluateGlucose, evaluatePressure, evaluatePulse, isBirthdayOnDate } from "./medical.js";
import { createElement as el, debounce, finiteInteger, makeId } from "./utils.js";
import { DEFAULT_BODY_PARTS, UNIT_BY_ID, directoryItemById, formatMedicationAmount, formatMedicationDose, hasOngoingPainForBodyPart, normalizedNameKey, parseMedicationAmount, validateDirectoryName } from "./pain.js";
import { DAY_PARTS, FOOD_RELATIONS, buildDaySchedule, formatMedicationExpirationRemaining, formatMedicationNameWithExpiration, isCourseCompletedOn, medicationExpirationStatus, validateMedicationCourse } from "./medications.js";
import { DEFAULT_GLASS_BLUR_INTENSITY, DEFAULT_GLASS_EFFECTS, DEFAULT_GLASS_TRANSPARENCY, DEFAULT_THEME, MAX_GLASS_BLUR_INTENSITY, MAX_GLASS_TRANSPARENCY, MIN_GLASS_BLUR_INTENSITY, MIN_GLASS_TRANSPARENCY, applyGlassBlurIntensity, applyGlassTransparency, applyTheme, applyUiSettings, detectInitialInterface, initializeTheme, initializeUiSettings, saveTheme, saveUiSettings } from "./interface-settings.js";
import { createAppInfoLoader, createChangeLoader } from "./app-info.js";

const PAGE_SIZE = 60;
const BIRTHDAY_EMOJIS = Object.freeze(["🎉", "🥳", "🎂", "🎊", "🎈", "🎁", "🍰"]);
const BACKUP_PENDING_KEY = "myhealth:backup-pending:v2";
const BACKUP_REMINDER_DISMISSED_KEY = "myhealth:backup-reminder-dismissed:v1";
const LEGACY_PORTRAIT_SAFE_TOP_KEY = "myhealth:portrait-safe-top:v1";
const SAFE_TOP_KEYS = Object.freeze({ portrait: "myhealth:safe-top:portrait:v2", landscape: "myhealth:safe-top:landscape:v2" });
const GLUCOSE_CONTEXT = Object.freeze({ fasting: "Натощак", beforeMeal: "Перед едой", after1h: "Через 1 час после начала еды", after2h: "Через 2 часа после начала еды", random: "Случайное измерение" });
const GLUCOSE_FORMAT = Object.freeze({ plasma: "Эквивалент плазмы", wholeBlood: "Цельная кровь" });
const PULSE_CONTEXT = Object.freeze({ resting: "В покое", active: "После физической нагрузки", unknown: "Контекст не указан" });
const COLLECTION_BY_KIND = Object.freeze({ pressure: "pressureMeasurements", pulse: "pulseMeasurements", pain: "painEpisodes", glucose: "glucoseMeasurements", weight: "weightMeasurements", temperature: "temperatureMeasurements", steps: "stepsMeasurements" });
const STORE_BY_KIND = Object.freeze({ pressure: STORES.pressure, pulse: STORES.pulse, pain: STORES.pain, glucose: STORES.glucose, weight: STORES.weight, temperature: STORES.temperature, steps: STORES.steps });
const DIRECTORY_META = Object.freeze({ bodyParts: { title: "Части тела", icon: "🧍" }, medications: { title: "Препараты", icon: "💊" } });
const APP_NAVIGATION_KEY = "myhealthNavigation";
const ROOT_VIEWS = new Set(["diary", "stats", "medications", "directories"]);
const SETTINGS_CHILD_VIEWS = new Set(["profile", "interface", "backup"]);
const ABOUT_CHILD_VIEWS = new Set(["changes", "description", "features"]);
const ENTRY_KEYBOARD_MIN_REDUCTION = 80;
let backupPendingFallback = false;
let backupReminderDismissedFallback = false;
let modalScrollY = 0;
let modalScrollRestoreFrame = 0;
let applyingNavigationState = false;
let pendingRootView = null;
let modalNavigationState = null;
const confirmedSafeTop = { portrait: null, landscape: null };
let safeTopCandidate = null;
let safeTopCandidateCount = 0;
let safeTopTimers = [];
let safeTopSyncRevision = 0;
let pageScrollRestoreId = 0;
let entryKeyboardSession = null;
let focusedEntryScrollFrame = 0;
let focusedEntryScrollTimer = 0;
let shellLayoutSyncFrame = 0;
let shellLayoutSyncTimer = 0;
let shellLayoutSyncRevision = 0;
let pendingShellScrollTop = null;
const loadAppInfoOnce = createAppInfoLoader();
const loadChangesOnce = createChangeLoader();

const initialUiSettings = (() => {
  try { return initializeUiSettings(); }
  catch { return { interface: detectInitialInterface(globalThis.navigator), glassTransparency: DEFAULT_GLASS_TRANSPARENCY, glassEffects: DEFAULT_GLASS_EFFECTS, glassBlurIntensity: DEFAULT_GLASS_BLUR_INTENSITY }; }
})();
const initialTheme = (() => {
  try { return initializeTheme(); }
  catch { return DEFAULT_THEME; }
})();
applyTheme(initialTheme);
applyUiSettings(initialUiSettings);

const state = {
  data: { profile: null, pressureMeasurements: [], pulseMeasurements: [], painEpisodes: [], glucoseMeasurements: [], weightMeasurements: [], temperatureMeasurements: [], stepsMeasurements: [], bodyParts: [], medications: [], medicationCourses: [], medicationIntakes: [] },
  diaryFilter: "all", diaryLimit: PAGE_SIZE, statsMetric: "overview", pendingImport: null,
  pressureWarningAccepted: false, chartObservers: [], glucoseContext: "all", glucoseFormat: "all", painBodyPart: "all", directoryContext: null, activeDirectory: null,
  medicationTab: "today", medicationDate: getMoscowFields().date, activeView: "diary", uiSettings: initialUiSettings, theme: initialTheme,
  appInfo: null, appInfoUnavailable: false, changes: null, changesUnavailable: false
};

const elements = {
  diaryView: document.querySelector("#diary-view"), statsView: document.querySelector("#stats-view"), settingsView: document.querySelector("#settings-view"), profileView: document.querySelector("#profile-view"), interfaceView: document.querySelector("#interface-view"), backupView: document.querySelector("#backup-view"), aboutView: document.querySelector("#about-view"), changesView: document.querySelector("#changes-view"), descriptionView: document.querySelector("#description-view"), featuresView: document.querySelector("#features-view"), directoriesView: document.querySelector("#directories-view"), medicationsView: document.querySelector("#medications-view"),
  diaryList: document.querySelector("#diary-list"), diaryFilterSelect: document.querySelector("#diary-filter-select"), loadMore: document.querySelector("#load-more-button"),
  statsContent: document.querySelector("#stats-content"), statsSubfilters: document.querySelector("#stats-subfilters"), statsBack: document.querySelector("#stats-back"),
  statsPeriod: document.querySelector("#stats-period"), customPeriod: document.querySelector("#custom-period"), periodStart: document.querySelector("#period-start"), periodEnd: document.querySelector("#period-end"),
  profileContent: document.querySelector("#profile-content"), changesContent: document.querySelector("#changes-content"), directoriesContent: document.querySelector("#directories-content"), directoriesHeading: document.querySelector("#directories-heading"), directoriesBack: document.querySelector("#directories-back"), directoryAdd: document.querySelector("#directory-add-button"), medicationsContent: document.querySelector("#medications-content"), medicationCourseAdd: document.querySelector("#medication-course-add"), offlineBanner: document.querySelector("#offline-banner"), storageWarning: document.querySelector("#storage-warning"), toast: document.querySelector("#toast")
};

function aboutSection(title, children) {
  return el("section", { className: "about-section", attrs: { "aria-labelledby": `about-${title.toLowerCase().replaceAll(" ", "-")}` } }, [
    el("h3", { text: title, attrs: { id: `about-${title.toLowerCase().replaceAll(" ", "-")}` } }), ...children
  ]);
}

function setAboutContentState(container, busy) {
  container.setAttribute("aria-busy", String(busy));
}

function renderAppInfo() {
  const info = state.appInfo;
  if (info) {
    const versionButton = document.querySelector("#app-version");
    versionButton.textContent = `v${info.version}`;
    versionButton.setAttribute("aria-label", versionButton.classList.contains("update-ready") ? `Версия v${info.version}: доступна новая версия, нажмите для обновления` : `Версия v${info.version}`);

    elements.changesContent.replaceChildren(
      aboutSection("Версия", [el("p", { text: info.version })]),
      aboutSection("Дата и время сборки", [el("p", { text: info.buildDate })]),
      state.changes
        ? aboutSection("Изменения", [el("ol", {}, state.changes.map((item) => el("li", { text: item })))])
        : state.changesUnavailable
          ? aboutSection("Изменения", [el("p", { className: "muted", text: "Информация об изменениях недоступна" })])
          : aboutSection("Изменения", [el("p", { className: "muted", text: "Загрузка изменений…" })])
    );
  } else if (state.appInfoUnavailable) {
    elements.changesContent.replaceChildren(emptyState("Информация о версии недоступна", "Попробуйте открыть раздел позже.", "ℹ️"));
  } else {
    elements.changesContent.replaceChildren(el("p", { className: "about-loading muted", text: "Загрузка информации…" }));
  }
  setAboutContentState(elements.changesContent, (!info && !state.appInfoUnavailable) || (!state.changes && !state.changesUnavailable));
}

function ensureAppInfo() {
  return loadAppInfoOnce()
    .then((info) => { state.appInfo = info; renderAppInfo(); return info; })
    .catch(() => { state.appInfoUnavailable = true; renderAppInfo(); return null; });
}

function ensureChanges() {
  return loadChangesOnce()
    .then((changes) => { state.changes = changes; renderAppInfo(); return changes; })
    .catch(() => { state.changesUnavailable = true; renderAppInfo(); return null; });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 2800);
}

function showError(container, error) { container.textContent = error instanceof Error ? error.message : String(error); }

function syncGlassRangeProgress(input) {
  const minimum = Number(input.min);
  const maximum = Number(input.max);
  const value = Number(input.value);
  const progress = maximum > minimum ? ((value - minimum) / (maximum - minimum)) * 100 : 0;
  input.closest(".unified-range-control")?.style.setProperty("--range-progress", `${Math.min(100, Math.max(0, progress))}%`);
}

function renderInterfaceSettings() {
  for (const option of document.querySelectorAll("[data-theme-choice]")) {
    const selected = option.dataset.themeChoice === state.theme;
    option.classList.toggle("selected", selected); option.setAttribute("aria-checked", String(selected));
  }
  for (const option of document.querySelectorAll("[data-interface-choice]")) {
    const selected = option.dataset.interfaceChoice === state.uiSettings.interface;
    option.classList.toggle("selected", selected); option.setAttribute("aria-checked", String(selected));
  }
  const transparency = document.querySelector("#glass-transparency");
  transparency.value = String(state.uiSettings.glassTransparency);
  document.querySelector("#glass-transparency-value").value = `${state.uiSettings.glassTransparency}%`;
  transparency.setAttribute("aria-valuetext", `${state.uiSettings.glassTransparency} процентов`);
  syncGlassRangeProgress(transparency);
  const isModern = state.uiSettings.interface === "modern";
  document.querySelector("#glass-transparency-card").hidden = !isModern;
  const effectsCard = document.querySelector("#glass-effects-card");
  effectsCard.hidden = !isModern;
  for (const option of effectsCard.querySelectorAll("[data-glass-effects-choice]")) {
    const selected = option.dataset.glassEffectsChoice === state.uiSettings.glassEffects;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
  }
  const blurCard = document.querySelector("#glass-blur-card");
  const blur = document.querySelector("#glass-blur-intensity");
  const blurOutput = document.querySelector("#glass-blur-value");
  const blurStatus = document.querySelector("#glass-blur-status");
  const blurDisabled = state.uiSettings.glassEffects === "none";
  blurCard.hidden = !isModern;
  blur.disabled = blurDisabled;
  blur.min = String(blurDisabled ? 0 : MIN_GLASS_BLUR_INTENSITY);
  blur.max = String(blurDisabled ? 0 : MAX_GLASS_BLUR_INTENSITY);
  blur.step = blurDisabled ? "1" : "0.01";
  blur.value = String(blurDisabled ? 0 : state.uiSettings.glassBlurIntensity);
  blurOutput.value = `${blurDisabled ? 0 : state.uiSettings.glassBlurIntensity}%`;
  blur.setAttribute("aria-valuetext", blurDisabled ? "0 процентов, размытие отключено выбранным режимом" : `${state.uiSettings.glassBlurIntensity} процентов`);
  syncGlassRangeProgress(blur);
  blurStatus.hidden = !blurDisabled;
}

function persistUiSettings(nextSettings) {
  const previousInterface = state.uiSettings.interface;
  const scrollTop = currentPageScrollTop();
  const saved = saveUiSettings(nextSettings);
  state.uiSettings = applyUiSettings(saved);
  renderInterfaceSettings();
  if (saved.interface !== previousInterface) scheduleShellLayoutSync(scrollTop);
}

function persistTheme(nextTheme) {
  state.theme = applyTheme(saveTheme(nextTheme));
  renderInterfaceSettings();
}

function previewGlassTransparency(input) {
  const value = Number(input.value);
  try {
    applyGlassTransparency(value);
    syncGlassRangeProgress(input);
    const rounded = Math.round(value);
    document.querySelector("#glass-transparency-value").value = `${rounded}%`;
    input.setAttribute("aria-valuetext", `${rounded} процентов`);
  } catch { /* The native range keeps preview values inside its bounds. */ }
}

function previewGlassBlurIntensity(input) {
  const value = Number(input.value);
  try {
    applyGlassBlurIntensity(value);
    syncGlassRangeProgress(input);
    const rounded = Math.round(value);
    document.querySelector("#glass-blur-value").value = `${rounded}%`;
    input.setAttribute("aria-valuetext", `${rounded} процентов`);
  } catch { /* The native range keeps preview values inside its bounds. */ }
}

function commitGlassBlurIntensity(input) {
  const intensity = Math.min(MAX_GLASS_BLUR_INTENSITY, Math.max(MIN_GLASS_BLUR_INTENSITY, Math.round(Number(input.value))));
  input.value = String(intensity);
  persistUiSettings({ ...state.uiSettings, glassBlurIntensity: intensity });
}

function handleGlassBlurIntensityKeydown(event) {
  const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
  if (!direction) return;
  event.preventDefault();
  event.currentTarget.value = String(Math.min(MAX_GLASS_BLUR_INTENSITY, Math.max(MIN_GLASS_BLUR_INTENSITY, Math.round(Number(event.currentTarget.value)) + direction)));
  commitGlassBlurIntensity(event.currentTarget);
}

function commitGlassTransparency(input) {
  const transparency = Math.min(MAX_GLASS_TRANSPARENCY, Math.max(MIN_GLASS_TRANSPARENCY, Math.round(Number(input.value))));
  input.value = String(transparency);
  persistUiSettings({ ...state.uiSettings, glassTransparency: transparency });
}

function handleGlassTransparencyKeydown(event) {
  const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
  if (!direction) return;
  event.preventDefault();
  event.currentTarget.value = String(Math.min(MAX_GLASS_TRANSPARENCY, Math.max(MIN_GLASS_TRANSPARENCY, Math.round(Number(event.currentTarget.value)) + direction)));
  commitGlassTransparency(event.currentTarget);
}

async function importWithUiSettings(importedSettings, importData) {
  const previousSettings = state.uiSettings;
  if (importedSettings) persistUiSettings({ ...previousSettings, ...importedSettings }); // Legacy backups preserve settings they do not contain.
  try { return await importData(); }
  catch (error) {
    if (importedSettings) {
      try { persistUiSettings(previousSettings); } catch { /* Keep the original import error. */ }
    }
    throw error;
  }
}
function isBackupPending() { try { return localStorage.getItem(BACKUP_PENDING_KEY) === "1"; } catch { return backupPendingFallback; } }
function isBackupReminderDismissed() { try { return localStorage.getItem(BACKUP_REMINDER_DISMISSED_KEY) === "1"; } catch { return backupReminderDismissedFallback; } }
function dismissBackupReminder() { backupReminderDismissedFallback = true; try { localStorage.setItem(BACKUP_REMINDER_DISMISSED_KEY, "1"); } catch { /* fallback in memory */ } }
function clearBackupReminderDismissed() { backupReminderDismissedFallback = false; try { localStorage.removeItem(BACKUP_REMINDER_DISMISSED_KEY); } catch { /* storage unavailable */ } }
function markBackupPending() { clearBackupReminderDismissed(); backupPendingFallback = true; try { localStorage.setItem(BACKUP_PENDING_KEY, "1"); } catch { /* fallback in memory */ } }
function clearBackupPending() { clearBackupReminderDismissed(); backupPendingFallback = false; try { localStorage.removeItem(BACKUP_PENDING_KEY); } catch { /* storage unavailable */ } }

function showBackupPrompt() {
  if (!isBackupPending() || isBackupReminderDismissed()) return;
  document.querySelector("#backup-prompt-error").textContent = "";
  if (!document.querySelector("#backup-prompt-dialog").open) { document.querySelector("#backup-dont-remind").checked = false; openDialog("#backup-prompt-dialog"); }
}

function handleSuccessfulDataChange(message) { markBackupPending(); showToast(message); showBackupPrompt(); }

function syncVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const layoutHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);
  const bottomInset = Math.max(0, layoutHeight - viewport.height - viewport.offsetTop);
  document.documentElement.style.setProperty("--visual-viewport-height", `${viewport.height}px`);
  document.documentElement.style.setProperty("--visual-viewport-bottom", `${bottomInset}px`);
  document.documentElement.style.setProperty("--visual-viewport-offset-top", `${viewport.offsetTop}px`);
}

function scheduleShellLayoutSync(scrollTop = null) {
  if (Number.isFinite(scrollTop)) pendingShellScrollTop = scrollTop;
  const revision = ++shellLayoutSyncRevision;
  cancelAnimationFrame(shellLayoutSyncFrame);
  clearTimeout(shellLayoutSyncTimer);
  const apply = () => {
    if (revision !== shellLayoutSyncRevision) return;
    if (Number.isFinite(pendingShellScrollTop)) restorePageScroll(pendingShellScrollTop);
  };
  shellLayoutSyncFrame = requestAnimationFrame(() => {
    shellLayoutSyncFrame = requestAnimationFrame(apply);
  });
  shellLayoutSyncTimer = setTimeout(() => {
    apply();
    if (revision === shellLayoutSyncRevision) pendingShellScrollTop = null;
  }, 160);
}

function isPortraitViewport() {
  return window.matchMedia("(orientation: portrait)").matches;
}

function viewportOrientation() {
  return isPortraitViewport() ? "portrait" : "landscape";
}

function measureSafeTop() {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
  document.documentElement.append(probe);
  const value = Number.parseFloat(getComputedStyle(probe).paddingTop);
  probe.remove();
  return Number.isFinite(value) && value >= 0 && value <= 80 ? value : null;
}

function restoreSafeTop(orientation) {
  if (confirmedSafeTop[orientation] !== null) return confirmedSafeTop[orientation];
  try {
    sessionStorage.removeItem(LEGACY_PORTRAIT_SAFE_TOP_KEY);
    const cached = Number.parseFloat(sessionStorage.getItem(SAFE_TOP_KEYS[orientation]));
    if (Number.isFinite(cached) && cached >= 0 && cached <= 80) confirmedSafeTop[orientation] = cached;
  } catch { /* session storage unavailable */ }
  return confirmedSafeTop[orientation];
}

function applySafeTop(value) {
  document.documentElement.style.setProperty("--shell-safe-top", `${Math.round(value * 100) / 100}px`);
}

function confirmSafeTop(orientation, value, revision) {
  if (revision !== safeTopSyncRevision || viewportOrientation() !== orientation) return;
  confirmedSafeTop[orientation] = value;
  applySafeTop(value);
  try { sessionStorage.setItem(SAFE_TOP_KEYS[orientation], String(value)); } catch { /* session storage unavailable */ }
}

function sampleSafeTop(orientation, revision, delay) {
  if (revision !== safeTopSyncRevision || viewportOrientation() !== orientation) return;
  const measured = measureSafeTop();
  if (measured === null) return;
  if (safeTopCandidate !== null && Math.abs(measured - safeTopCandidate) <= .5) safeTopCandidateCount += 1;
  else { safeTopCandidate = measured; safeTopCandidateCount = 1; }
  if (safeTopCandidateCount < 3 || delay < 360) return;
  confirmSafeTop(orientation, measured, revision);
}

function scheduleSafeTopSync() {
  for (const timer of safeTopTimers) clearTimeout(timer);
  safeTopTimers = [];
  const revision = ++safeTopSyncRevision;
  const orientation = viewportOrientation();
  const cached = restoreSafeTop(orientation);
  if (cached !== null) applySafeTop(cached);
  safeTopCandidate = null;
  safeTopCandidateCount = 0;
  safeTopTimers = [0, 60, 180, 360, 720, 1200, 1600].map((delay) => setTimeout(() => sampleSafeTop(orientation, revision, delay), delay));
}

function pageScrollContainer() {
  return document.querySelector(".app-main");
}

function scrollPageToTop(behavior = "smooth") {
  pageScrollRestoreId += 1;
  const scroller = pageScrollContainer();
  scroller?.scrollTo({ top: 0, behavior });
}

function currentPageScrollTop() {
  return pageScrollContainer()?.scrollTop || 0;
}

function restorePageScroll(top) {
  const scrollTop = Number.isFinite(top) && top >= 0 ? top : 0;
  const restoreId = ++pageScrollRestoreId;
  const restore = () => {
    if (restoreId !== pageScrollRestoreId) return;
    const scroller = pageScrollContainer();
    scroller?.scrollTo({ top: scrollTop, behavior: "auto" });
  };
  restore();
  requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
  setTimeout(restore, 80);
}

function syncModalState() {
  const hasOpenDialog = Boolean(document.querySelector("dialog[open]"));
  const root = document.documentElement;
  const scroller = pageScrollContainer();
  for (const surface of [document.querySelector(".app-header"), document.querySelector(".app-main"), document.querySelector(".bottom-nav")]) if (surface) surface.inert = hasOpenDialog;
  if (hasOpenDialog && !root.classList.contains("modal-open")) {
    modalScrollY = scroller?.scrollTop || 0;
    root.classList.add("modal-open");
  } else if (!hasOpenDialog && root.classList.contains("modal-open")) {
    root.classList.remove("modal-open");
    if (scroller) restorePageScroll(modalScrollY);
  }
  if (hasOpenDialog) scheduleModalBackgroundScrollRestore();
}

function scheduleModalBackgroundScrollRestore() {
  cancelAnimationFrame(modalScrollRestoreFrame);
  modalScrollRestoreFrame = requestAnimationFrame(() => {
    const scroller = pageScrollContainer();
    if (document.documentElement.classList.contains("modal-open") && scroller && scroller.scrollTop !== modalScrollY) scroller.scrollTop = modalScrollY;
  });
}

function entryKeyboardContext() {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement)) return null;
  const dialog = field.closest("dialog.entry-form-dialog[open]");
  const scroller = dialog?.querySelector(".entry-form-content");
  if (!scroller || !scroller.contains(field)) return null;
  return { dialog, field, scroller };
}

function isMobileEntryViewport() {
  const mobileInput = navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return mobileInput && Math.min(screen.width, screen.height) <= 720;
}

function clearEntryKeyboardState(dialog = entryKeyboardSession?.dialog) {
  if (dialog) {
    dialog.classList.remove("entry-keyboard-open");
    dialog.style.removeProperty("--entry-keyboard-viewport-height");
    dialog.style.removeProperty("--entry-keyboard-offset-top");
  }
  if (!dialog || entryKeyboardSession?.dialog === dialog) {
    entryKeyboardSession = null;
    document.documentElement.classList.remove("entry-keyboard-active");
    document.documentElement.style.removeProperty("--entry-keyboard-shell-width");
    document.documentElement.style.removeProperty("--entry-keyboard-shell-height");
  }
}

function expectedEntryViewportHeight() {
  const shortSide = Math.min(screen.width, screen.height);
  const longSide = Math.max(screen.width, screen.height);
  return isPortraitViewport() ? longSide : shortSide;
}

function syncEntryKeyboardState() {
  const context = entryKeyboardContext();
  const viewport = window.visualViewport;
  if (!context || !viewport || !isMobileEntryViewport()) {
    clearEntryKeyboardState();
    return false;
  }
  const orientation = isPortraitViewport() ? "portrait" : "landscape";
  if (!entryKeyboardSession || entryKeyboardSession.dialog !== context.dialog) {
    entryKeyboardSession = { dialog: context.dialog, orientation, baselineHeight: viewport.height, baselineWidth: viewport.width };
  } else if (entryKeyboardSession.orientation !== orientation) {
    const previousBaselineWidth = entryKeyboardSession.baselineWidth;
    entryKeyboardSession.orientation = orientation;
    entryKeyboardSession.baselineHeight = Math.max(expectedEntryViewportHeight(), previousBaselineWidth);
    entryKeyboardSession.baselineWidth = viewport.width;
  } else if (!context.dialog.classList.contains("entry-keyboard-open")) {
    entryKeyboardSession.baselineHeight = Math.max(entryKeyboardSession.baselineHeight, viewport.height);
    entryKeyboardSession.baselineWidth = Math.max(entryKeyboardSession.baselineWidth, viewport.width);
  }
  const threshold = Math.max(ENTRY_KEYBOARD_MIN_REDUCTION, entryKeyboardSession.baselineHeight * .18);
  const keyboardOpen = entryKeyboardSession.baselineHeight - viewport.height >= threshold;
  context.dialog.classList.toggle("entry-keyboard-open", keyboardOpen);
  document.documentElement.classList.toggle("entry-keyboard-active", keyboardOpen);
  if (keyboardOpen) {
    context.dialog.style.setProperty("--entry-keyboard-viewport-height", `${viewport.height}px`);
    context.dialog.style.setProperty("--entry-keyboard-offset-top", `${viewport.offsetTop}px`);
    document.documentElement.style.setProperty("--entry-keyboard-shell-width", `${entryKeyboardSession.baselineWidth}px`);
    document.documentElement.style.setProperty("--entry-keyboard-shell-height", `${entryKeyboardSession.baselineHeight}px`);
  } else {
    context.dialog.style.removeProperty("--entry-keyboard-viewport-height");
    context.dialog.style.removeProperty("--entry-keyboard-offset-top");
    document.documentElement.style.removeProperty("--entry-keyboard-shell-width");
    document.documentElement.style.removeProperty("--entry-keyboard-shell-height");
  }
  return keyboardOpen;
}

function ensureFocusedEntryFieldVisible() {
  const context = entryKeyboardContext();
  if (!context || !context.dialog.classList.contains("entry-keyboard-open")) return true;
  const { field, scroller } = context;
  const targetBounds = field.getBoundingClientRect();
  const scrollerBounds = scroller.getBoundingClientRect();
  const inset = 8;
  const availableHeight = Math.max(0, scrollerBounds.height - inset * 2);
  let delta = 0;
  if (targetBounds.height > availableHeight) {
    if (targetBounds.top < scrollerBounds.top + inset || targetBounds.bottom > scrollerBounds.bottom - inset) {
      delta = targetBounds.top - scrollerBounds.top - inset;
    }
  } else if (targetBounds.bottom > scrollerBounds.bottom - inset) {
    delta = targetBounds.bottom - scrollerBounds.bottom + inset;
  } else if (targetBounds.top < scrollerBounds.top + inset) {
    delta = targetBounds.top - scrollerBounds.top - inset;
  }
  if (delta) scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta));
  const updatedBounds = field.getBoundingClientRect();
  const updatedScrollerBounds = scroller.getBoundingClientRect();
  return updatedBounds.top >= updatedScrollerBounds.top - .75 && updatedBounds.bottom <= updatedScrollerBounds.bottom + .75;
}

function retryFocusedEntryFieldVisibility(attempt = 0) {
  clearTimeout(focusedEntryScrollTimer);
  const context = entryKeyboardContext();
  if (!context || !context.dialog.classList.contains("entry-keyboard-open")) return;
  ensureFocusedEntryFieldVisible();
  if (attempt >= 7) return;
  focusedEntryScrollTimer = setTimeout(() => retryFocusedEntryFieldVisibility(attempt + 1), 80);
}

function scheduleFocusedEntryFieldVisibility() {
  cancelAnimationFrame(focusedEntryScrollFrame);
  clearTimeout(focusedEntryScrollTimer);
  focusedEntryScrollFrame = requestAnimationFrame(() => {
    focusedEntryScrollFrame = requestAnimationFrame(() => retryFocusedEntryFieldVisibility());
  });
}

function navigationState() {
  const value = history.state?.[APP_NAVIGATION_KEY];
  if (value?.version !== 1 || !Number.isInteger(value.depth) || value.depth < 0) return null;
  return { ...value, scrollTop: Number.isFinite(value.scrollTop) && value.scrollTop >= 0 ? value.scrollTop : 0 };
}

function navigationSnapshot(depth = navigationState()?.depth || 0, scrollTop = currentPageScrollTop()) {
  return {
    [APP_NAVIGATION_KEY]: {
      version: 1,
      depth,
      view: state.activeView,
      directory: state.activeView === "directories" ? state.activeDirectory : null,
      statsMetric: state.activeView === "stats" ? state.statsMetric : "overview",
      scrollTop
    }
  };
}

function replaceNavigationEntry(depth = navigationState()?.depth || 0) { history.replaceState(navigationSnapshot(depth), ""); }
function saveCurrentNavigationScroll() {
  const current = navigationState();
  if (current) history.replaceState(navigationSnapshot(current.depth, currentPageScrollTop()), "");
}
function pushNavigationEntry() { history.pushState(navigationSnapshot((navigationState()?.depth || 0) + 1, 0), ""); }

function hideDialog(dialog) {
  if (!dialog?.open) return;
  clearEntryKeyboardState(dialog);
  dialog.close();
  if (!document.querySelector("dialog[open]")) modalNavigationState = null;
  queueMicrotask(syncModalState);
}

function closeDialog(dialog) {
  if (!dialog?.open) return Promise.resolve(false);
  hideDialog(dialog);
  return Promise.resolve(true);
}

function openDialog(selector) {
  const dialog = document.querySelector(selector);
  if (!dialog.open) {
    clearEntryKeyboardState(dialog);
    if (!document.querySelector("dialog[open]")) modalNavigationState = navigationState();
    const entryContent = dialog.matches(".entry-form-dialog") ? dialog.querySelector(".entry-form-content") : null;
    dialog.showModal();
    if (entryContent) {
      entryContent.scrollTop = 0;
      dialog.querySelector(".close-button")?.focus({ preventScroll: true });
      requestAnimationFrame(() => { entryContent.scrollTop = 0; });
    }
    syncModalState();
  }
  return dialog;
}

function replaceDialog(dialog, openReplacement) {
  hideDialog(dialog);
  openReplacement();
}

function setBusy(button, busy, busyLabel = "Сохранение…") {
  if (busy) { button.dataset.label = button.textContent; button.textContent = busyLabel; button.disabled = true; }
  else { button.textContent = button.dataset.label || "Сохранить"; button.disabled = false; }
}

function recordTime(kind, record) { if (kind === "pain") return record.startedAt; if (kind === "steps") return `${record.measuredDate}T09:00:00.000Z`; return record.measuredAt; }
function newestWeight(items = state.data.weightMeasurements) { return [...items].sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt))[0] || null; }
function profileAge() { return state.data.profile ? ageOnDate(state.data.profile.birthDate, new Date(`${getMoscowFields().date}T12:00:00.000Z`)) : null; }
function ageLabel(age) { if (!Number.isFinite(age)) return "—"; const mod100 = age % 100; const mod10 = age % 10; const word = mod100 >= 11 && mod100 <= 14 ? "лет" : mod10 === 1 ? "год" : mod10 >= 2 && mod10 <= 4 ? "года" : "лет"; return `${age} ${word}`; }
function updateBirthdayBrand() {
  const container = document.querySelector("#brand-icon-container"); const emoji = container.querySelector(".brand-emoji"); const icon = container.querySelector(".brand-icon");
  const birthday = isBirthdayOnDate(state.data.profile?.birthDate, getMoscowFields().date);
  container.classList.toggle("birthday", birthday);
  if (birthday) { emoji.textContent = BIRTHDAY_EMOJIS[Math.floor(Math.random() * BIRTHDAY_EMOJIS.length)]; emoji.hidden = false; icon.hidden = true; }
  else { emoji.textContent = ""; emoji.hidden = true; icon.hidden = false; }
}
function formatGlucose(value) { return Number(value).toFixed(1).replace(".", ","); }
function formatOneDecimal(value) { return Number.isFinite(value) ? Number(value).toFixed(1).replace(".", ",") : "—"; }
function formatMetricOneDecimal(value) { return Number.isFinite(value) ? Number(value).toFixed(1) : "—"; }
function formatSigned(value, unit = "") { if (!Number.isFinite(value)) return "—"; return `${value > 0 ? "+" : ""}${formatMetricOneDecimal(value)}${unit}`; }
function formatDateOnly(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join(".") : "—"; }
function recordCountLabel(count) { const mod100 = count % 100; const mod10 = count % 10; const word = mod100 >= 11 && mod100 <= 14 ? "записей" : mod10 === 1 ? "запись" : mod10 >= 2 && mod10 <= 4 ? "записи" : "записей"; return `${count} ${word}`; }
function directoryCountLabel(count) { const mod100 = count % 100; const mod10 = count % 10; const word = mod100 >= 11 && mod100 <= 14 ? "элементов" : mod10 === 1 ? "элемент" : mod10 >= 2 && mod10 <= 4 ? "элемента" : "элементов"; return `${count} ${word}`; }
function evaluatePulseRecord(record) { const context = record.context || "unknown"; return evaluatePulse(record.pulse, { restingKnown: context === "resting", contextKnown: context !== "unknown", age: profileAge() }); }

function validateWeightInput(value) {
  const raw = String(value).trim();
  const weight = Number(raw.replace(",", "."));
  if (!/^\d+(?:[.,]\d)?$/.test(raw) || !Number.isFinite(weight) || weight < 1 || weight > 700) return { error: "Допустимое значение веса: 1–700 кг, один знак после запятой или точки" };
  return { weight };
}

function validDiaryDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > getMoscowFields().date) return false;
  const [year, month, day] = value.split("-").map(Number); const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function statusChip(status, compact = false) {
  return el("span", { className: `metric-status status-${status.level}${compact ? " compact" : ""}`, attrs: { "aria-label": status.text, title: status.explanation || "" } }, [
    el("span", { text: status.emoji, attrs: { "aria-hidden": "true" } }), document.createTextNode(status.text)
  ]);
}

async function refreshData() {
  state.data = await getAllData();
  for (const [key, dateKey] of [["pressureMeasurements", "measuredAt"], ["pulseMeasurements", "measuredAt"], ["painEpisodes", "startedAt"], ["glucoseMeasurements", "measuredAt"], ["weightMeasurements", "measuredAt"], ["temperatureMeasurements", "measuredAt"], ["stepsMeasurements", "measuredDate"]]) {
    state.data[key].sort((a, b) => new Date(b[dateKey]) - new Date(a[dateKey]));
  }
  const bodyOrder = new Map(DEFAULT_BODY_PARTS.map((item, index) => [item.id, index]));
  state.data.bodyParts.sort((a, b) => (bodyOrder.get(a.id) ?? 999) - (bodyOrder.get(b.id) ?? 999) || a.name.localeCompare(b.name, "ru"));
  state.data.medications.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  state.data.medicationCourses.sort((a, b) => b.startDate.localeCompare(a.startDate) || b.editedAt.localeCompare(a.editedAt));
  state.data.medicationIntakes.sort((a, b) => `${b.scheduledDate}T${b.scheduledTime}`.localeCompare(`${a.scheduledDate}T${a.scheduledTime}`));
  renderDiary(); renderProfile(); renderDirectories(); refreshDirectoryOptions();
  renderMedications();
  if (!elements.statsView.hidden) renderStatistics();
}

function emptyState(title, text, icon = "➕") {
  return el("div", { className: "empty-state" }, [el("span", { className: "empty-icon", text: icon, attrs: { "aria-hidden": "true" } }), el("strong", { text: title }), el("span", { text })]);
}

function actionButton(label, symbol, action, kind, id) {
  return el("button", { className: "card-action", type: "button", text: symbol, dataset: { action, kind, id }, attrs: { "aria-label": label } });
}

function entryShell(kind, record, main, label) {
  const time = recordTime(kind, record);
  return el("article", { className: `entry-card ${kind}` }, [
    el("time", { className: "entry-time", text: kind === "steps" ? "За день" : formatTime(time), attrs: { datetime: time } }), main,
    el("div", { className: "card-actions" }, [actionButton(`Редактировать ${label}`, "✏️", "edit", kind, record.id), actionButton(`Удалить ${label}`, "🗑️", "delete", kind, record.id)])
  ]);
}

function pressureCard(record) {
  const status = evaluatePressure(record.systolic, record.diastolic);
  const main = el("div", { className: "entry-main" }, [
    el("div", { className: "entry-type" }, [el("span", { className: "entry-emoji", text: "🩺", attrs: { "aria-hidden": "true" } }), document.createTextNode("Давление")]),
    el("div", { className: "entry-value", text: `${record.systolic} / ${record.diastolic}` }), statusChip(status, true)
  ]);
  if (record.comment) main.append(el("p", { className: "entry-comment", text: record.comment }));
  return entryShell("pressure", record, main, "измерение давления");
}

function pulseCard(record) {
  const status = evaluatePulseRecord(record);
  const main = el("div", { className: "entry-main" }, [
    el("div", { className: "entry-type" }, [el("span", { className: "entry-emoji", text: "💓", attrs: { "aria-hidden": "true" } }), document.createTextNode("Пульс")]),
    el("div", { className: "entry-value", text: `${record.pulse} уд/мин` }), el("p", { className: "entry-detail", text: PULSE_CONTEXT[record.context] || PULSE_CONTEXT.unknown }), statusChip(status, true)
  ]);
  const additional = [Number.isInteger(record.spo2) ? `SpO2 ${record.spo2}%` : "", Number.isInteger(record.stress) ? `Стресс ${record.stress}%` : ""].filter(Boolean).join(" · ");
  if (additional) main.append(el("p", { className: "entry-detail", text: additional }));
  if (record.comment) main.append(el("p", { className: "entry-comment", text: record.comment }));
  return entryShell("pulse", record, main, "измерение пульса");
}

function painCard(record) {
  const ongoing = record.endedAt === null;
  const duration = new Date(ongoing ? Date.now() : record.endedAt) - new Date(record.startedAt);
  const details = [ongoing ? `Начало ${formatTime(record.startedAt)}` : `${formatTime(record.startedAt)}–${formatTime(record.endedAt)} · ${formatDuration(duration)}`];
  const intensityMin = record.intensityMin ?? record.intensity; const intensityMax = record.intensityMax ?? record.intensity;
  const bodyPart = directoryItemById(state.data.bodyParts, record.bodyPartId)?.name || "Неизвестная область";
  const medication = directoryItemById(state.data.medications, record.medicationId)?.name;
  if (medication) {
    const dose = formatMedicationDose(record.medicationAmount, record.medicationUnitId);
    details.push([medication, dose, record.medicationTakenAt ? formatTime(record.medicationTakenAt) : ""].filter(Boolean).join(" · "));
  }
  const intensityLabel = intensityMin === intensityMax ? String(intensityMax) : `${intensityMin}–${intensityMax}`;
  const main = el("div", { className: "entry-main" }, [el("div", { className: "entry-type" }, [el("span", { className: "entry-emoji", text: "⚡", attrs: { "aria-hidden": "true" } }), document.createTextNode(`Боль · ${bodyPart}`)]), el("div", { className: "entry-value", text: `Интенсивность ${intensityLabel}` }), ...details.map((text) => el("p", { className: "entry-detail", text }))]);
  if (ongoing) main.append(el("span", { className: "status-chip" }, [el("span", { text: "⏱️", attrs: { "aria-hidden": "true" } }), document.createTextNode("Приступ продолжается")]));
  if (record.comment) main.append(el("p", { className: "entry-comment", text: record.comment }));
  return entryShell("pain", record, main, "эпизод боли");
}

function glucoseCard(record) {
  const status = evaluateGlucose({ ...record, age: profileAge() });
  const main = el("div", { className: "entry-main" }, [
    el("div", { className: "entry-type" }, [el("span", { className: "entry-emoji", text: "🩸", attrs: { "aria-hidden": "true" } }), document.createTextNode("Глюкоза")]),
    el("div", { className: "entry-value", text: `${formatGlucose(record.value)} ммоль/л` }),
    el("p", { className: "entry-detail", text: GLUCOSE_CONTEXT[record.context] }), el("p", { className: "entry-detail", text: GLUCOSE_FORMAT[record.format] }), statusChip(status, true)
  ]);
  if (record.comment) main.append(el("p", { className: "entry-comment", text: record.comment }));
  return entryShell("glucose", record, main, "измерение глюкозы");
}

function weightCard(record) {
  const previous = state.data.weightMeasurements.filter((item) => new Date(item.measuredAt) < new Date(record.measuredAt)).sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt))[0];
  const bmi = calculateBmi(record.weight, state.data.profile?.heightCm);
  const status = evaluateBmi({ bmi, age: profileAge() });
  const main = el("div", { className: "entry-main" }, [
    el("div", { className: "entry-type" }, [el("span", { className: "entry-emoji", text: "⚖️", attrs: { "aria-hidden": "true" } }), document.createTextNode("Вес")]),
    el("div", { className: "entry-value", text: `${formatMetricOneDecimal(record.weight)} кг` }), el("p", { className: "entry-detail", text: previous ? `Изменение ${formatSigned(record.weight - previous.weight, " кг")}` : "Первое измерение" }), statusChip(status, true)
  ]);
  if (record.comment) main.append(el("p", { className: "entry-comment", text: record.comment }));
  return entryShell("weight", record, main, "измерение веса");
}

function temperatureCard(record) {
  const main = el("div", { className: "entry-main" }, [
    el("div", { className: "entry-type" }, [el("span", { className: "entry-emoji", text: "🌡️", attrs: { "aria-hidden": "true" } }), document.createTextNode("Температура")]),
    el("div", { className: "entry-value", text: `${formatMetricOneDecimal(record.temperature)} °C` })
  ]);
  return entryShell("temperature", record, main, "измерение температуры");
}

function stepsCard(record) {
  const main = el("div", { className: "entry-main" }, [
    el("div", { className: "entry-type" }, [el("span", { className: "entry-emoji", text: "👟", attrs: { "aria-hidden": "true" } }), document.createTextNode("Шаги")]),
    el("div", { className: "entry-value", text: `${record.steps} шагов` })
  ]);
  return entryShell("steps", record, main, "запись шагов");
}

function renderDiary() {
  const events = [];
  for (const kind of Object.keys(COLLECTION_BY_KIND)) {
    if (state.diaryFilter !== "all" && state.diaryFilter !== kind) continue;
    for (const item of state.data[COLLECTION_BY_KIND[kind]]) events.push({ kind, time: recordTime(kind, item), item });
  }
  events.sort((a, b) => new Date(b.time) - new Date(a.time));
  const visible = events.slice(0, state.diaryLimit);
  elements.diaryList.replaceChildren(); elements.loadMore.hidden = events.length <= visible.length;
  if (!events.length) {
    const any = Object.values(COLLECTION_BY_KIND).some((key) => state.data[key].length);
    elements.diaryList.append(emptyState(any ? "Нет записей в этом разделе" : "Записей пока нет", any ? "Выберите другой фильтр." : "Добавьте первое измерение или эпизод.", "📝")); return;
  }
  let currentDay = null; let group = null;
  for (const event of visible) {
    const day = getDateKey(event.time);
    if (day !== currentDay) { currentDay = day; group = el("section", { className: "day-group", attrs: { "aria-label": formatDayLabel(event.time) } }, [el("h3", { className: "day-label", text: formatDayLabel(event.time) })]); elements.diaryList.append(group); }
    group.append({ pressure: pressureCard, pulse: pulseCard, pain: painCard, glucose: glucoseCard, weight: weightCard, temperature: temperatureCard, steps: stepsCard }[event.kind](event.item));
  }
}

function setDiaryFilter(filter) {
  if (filter !== "all" && !COLLECTION_BY_KIND[filter]) return;
  state.diaryFilter = filter;
  state.diaryLimit = PAGE_SIZE;
  elements.diaryFilterSelect.value = filter;
  document.querySelectorAll("#diary-filter button").forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderDiary();
}

function moscowDateTimeValue(value = new Date()) { const fields = getMoscowFields(value); return `${fields.date}T${fields.time}`; }
function setMoscowNow(input) { input.value = moscowDateTimeValue(); }
function syncNotFutureConstraint(input) { input.max = moscowDateTimeValue(); }

function fillMeasurementForm(prefix, record) {
  const input = document.querySelector(`#${prefix}-datetime`);
  if (record) input.value = moscowDateTimeValue(record.measuredAt); else setMoscowNow(input);
  syncNotFutureConstraint(input);
}

function openPressureForm(record = null) {
  document.querySelector("#pressure-form").reset(); document.querySelector("#pressure-error").textContent = ""; document.querySelector("#pressure-warning").hidden = true; state.pressureWarningAccepted = false;
  document.querySelector("#pressure-id").value = record?.id || ""; document.querySelector("#pressure-form-title").textContent = record ? "Редактировать измерение" : "Новое измерение"; fillMeasurementForm("pressure", record);
  if (record) { document.querySelector("#systolic").value = record.systolic; document.querySelector("#diastolic").value = record.diastolic; document.querySelector("#pressure-comment").value = record.comment; }
  openDialog("#pressure-dialog");
}

function openPulseForm(record = null) {
  document.querySelector("#pulse-form").reset(); document.querySelector("#pulse-error").textContent = ""; document.querySelector("#pulse-id").value = record?.id || ""; document.querySelector("#pulse-form-title").textContent = record ? "Редактировать измерение" : "Новое измерение"; fillMeasurementForm("pulse", record);
  if (record) { document.querySelector("#pulse-value").value = record.pulse; document.querySelector("#pulse-context").value = ["resting", "active"].includes(record.context) ? record.context : "unknown"; document.querySelector("#pulse-spo2").value = record.spo2 ?? ""; document.querySelector("#pulse-stress").value = record.stress ?? ""; document.querySelector("#pulse-comment").value = record.comment; }
  openDialog("#pulse-dialog");
}

function openGlucoseForm(record = null) {
  document.querySelector("#glucose-form").reset(); document.querySelector("#glucose-error").textContent = ""; document.querySelector("#glucose-id").value = record?.id || ""; document.querySelector("#glucose-form-title").textContent = record ? "Редактировать измерение" : "Новое измерение"; fillMeasurementForm("glucose", record);
  if (record) { document.querySelector("#glucose-value").value = formatGlucose(record.value); document.querySelector("#glucose-format").value = record.format; document.querySelector("#glucose-context").value = record.context; document.querySelector("#glucose-comment").value = record.comment; }
  openDialog("#glucose-dialog");
}

function openWeightForm(record = null) {
  document.querySelector("#weight-form").reset(); document.querySelector("#weight-error").textContent = ""; document.querySelector("#weight-id").value = record?.id || ""; document.querySelector("#weight-form-title").textContent = record ? "Редактировать измерение" : "Новое измерение"; fillMeasurementForm("weight", record);
  if (record) { document.querySelector("#weight-value").value = formatMetricOneDecimal(record.weight); document.querySelector("#weight-comment").value = record.comment; }
  openDialog("#weight-dialog");
}

function openTemperatureForm(record = null) {
  document.querySelector("#temperature-form").reset(); document.querySelector("#temperature-error").textContent = ""; document.querySelector("#temperature-id").value = record?.id || ""; document.querySelector("#temperature-form-title").textContent = record ? "Редактировать измерение" : "Новое измерение"; fillMeasurementForm("temperature", record);
  if (record) document.querySelector("#temperature-value").value = formatMetricOneDecimal(record.temperature);
  openDialog("#temperature-dialog");
}

function openStepsForm(record = null) {
  document.querySelector("#steps-form").reset(); document.querySelector("#steps-error").textContent = ""; document.querySelector("#steps-id").value = record?.id || ""; document.querySelector("#steps-form-title").textContent = record ? "Редактировать шаги" : "Шаги за день";
  const dateInput = document.querySelector("#steps-date"); dateInput.max = getMoscowFields().date; dateInput.value = record?.measuredDate || getMoscowFields().date;
  if (record) document.querySelector("#steps-value").value = record.steps;
  openDialog("#steps-dialog");
}

function syncHeadacheEndFields(updateValue = false) {
  const ongoing = document.querySelector("#headache-ongoing").checked;
  const endInput = document.querySelector("#headache-end-datetime");
  document.querySelector("#headache-end-fields").disabled = ongoing;
  if (updateValue && ongoing) endInput.value = "";
  if (updateValue && !ongoing) setMoscowNow(endInput);
}

function readHeadachePeriod() {
  const startedAt = moscowDateTimeInputToIso(document.querySelector("#headache-start-datetime").value);
  if (isFuture(startedAt)) throw new Error("Начало приступа не может быть в будущем.");
  let endedAt = null;
  if (!document.querySelector("#headache-ongoing").checked) {
    endedAt = moscowDateTimeInputToIso(document.querySelector("#headache-end-datetime").value);
    if (isFuture(endedAt)) throw new Error("Окончание приступа не может быть в будущем.");
    if (new Date(endedAt) < new Date(startedAt)) throw new Error("Окончание не может быть раньше начала.");
  }
  return { startedAt, endedAt };
}

function roundedIntensity(value) { const number = Number(value); return Number.isFinite(number) && number >= 1 && number <= 10 ? Math.round(number) : null; }
function updateIntensityDisplay(input) {
  const intensity = roundedIntensity(input.value); if (intensity === null) return;
  input.closest(".unified-range-control")?.style.setProperty("--range-progress", `${((Number(input.value) - 1) / 9) * 100}%`); document.querySelector(`#${input.id}-output`).value = intensity; input.setAttribute("aria-valuetext", `${intensity} из 10`);
  const minimum = document.querySelector("#intensity-min"); const maximum = document.querySelector("#intensity-max");
  if (input === minimum && Number(minimum.value) > Number(maximum.value)) { maximum.value = minimum.value; updateIntensityDisplay(maximum); }
  if (input === maximum && Number(maximum.value) < Number(minimum.value)) { minimum.value = maximum.value; updateIntensityDisplay(minimum); }
}
function snapIntensity(input) { const intensity = roundedIntensity(input.value); if (intensity !== null) { input.value = intensity; updateIntensityDisplay(input); } }
function handleIntensityKeydown(event) { const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key]; if (!direction) return; event.preventDefault(); event.currentTarget.value = Math.min(10, Math.max(1, (roundedIntensity(event.currentTarget.value) ?? 5) + direction)); updateIntensityDisplay(event.currentTarget); }

function syncVariableIntensity(updateValues = false) {
  const variable = document.querySelector("#headache-variable-intensity").checked;
  const single = document.querySelector("#intensity"); const minimum = document.querySelector("#intensity-min"); const maximum = document.querySelector("#intensity-max");
  document.querySelector("#intensity-single-field").hidden = variable;
  document.querySelector("#intensity-range-fields").hidden = !variable;
  if (updateValues && variable) minimum.value = maximum.value = roundedIntensity(single.value) ?? 5;
  if (updateValues && !variable) single.value = roundedIntensity(maximum.value) ?? 5;
  for (const input of [single, minimum, maximum]) updateIntensityDisplay(input);
}

function readIntensityRange() {
  if (!document.querySelector("#headache-variable-intensity").checked) {
    const intensity = roundedIntensity(document.querySelector("#intensity").value);
    if (intensity === null) throw new Error("Интенсивность должна быть от 1 до 10.");
    return { intensityMin: intensity, intensityMax: intensity };
  }
  const intensityMin = roundedIntensity(document.querySelector("#intensity-min").value); const intensityMax = roundedIntensity(document.querySelector("#intensity-max").value);
  if (intensityMin === null || intensityMax === null) throw new Error("Интенсивность должна быть от 1 до 10.");
  if (intensityMin > intensityMax) throw new Error("Минимальная интенсивность не может быть выше максимальной.");
  return { intensityMin, intensityMax };
}

function refreshDirectoryOptions() {
  document.querySelector("#body-part").replaceChildren(...state.data.bodyParts.map((item) => el("option", { value: item.id, text: item.name })));
  document.querySelector("#medication").replaceChildren(el("option", { value: "", text: "Не выбрано" }), ...state.data.medications.map((item) => el("option", { value: item.id, text: item.name })));
  refreshCourseMedicationOptions();
}

function selectedBodyPart() {
  const item = directoryItemById(state.data.bodyParts, document.querySelector("#body-part").value);
  if (!item) throw new Error("Выберите часть тела из справочника или добавьте новую кнопкой «+».");
  return item;
}

function checkOngoingPain(showMessage = true) {
  const item = directoryItemById(state.data.bodyParts, document.querySelector("#body-part").value); if (!item) return false;
  const duplicate = hasOngoingPainForBodyPart(state.data.painEpisodes, item.id, document.querySelector("#headache-id").value || null);
  if (duplicate && showMessage) document.querySelector("#headache-error").textContent = `Приступ боли в области «${item.name}» уже продолжается. Завершите его через редактирование записи.`;
  return duplicate;
}

function syncMedicationDateTime() {
  const medication = directoryItemById(state.data.medications, document.querySelector("#medication").value);
  const controls = [document.querySelector("#medication-amount"), document.querySelector("#medication-unit"), document.querySelector("#medication-datetime")];
  for (const input of controls) input.disabled = !medication;
  if (!medication) for (const input of controls) input.value = "";
}

function readMedication(startedAt) {
  const medicationId = document.querySelector("#medication").value; if (!medicationId) return { medicationId: null, medicationAmount: null, medicationUnitId: null, medicationTakenAt: null };
  const medication = directoryItemById(state.data.medications, medicationId); if (!medication) throw new Error("Выберите препарат из справочника или добавьте новый кнопкой «+».");
  const medicationAmount = parseMedicationAmount(document.querySelector("#medication-amount").value);
  const medicationUnitId = document.querySelector("#medication-unit").value; if (!UNIT_BY_ID[medicationUnitId]) throw new Error("Выберите единицу измерения препарата.");
  const value = document.querySelector("#medication-datetime").value; if (!value) return { medicationId: medication.id, medicationAmount, medicationUnitId, medicationTakenAt: null };
  const medicationTakenAt = moscowDateTimeInputToIso(value);
  if (isFuture(medicationTakenAt)) throw new Error("Дата и время приёма препарата не могут быть в будущем.");
  if (new Date(medicationTakenAt) < new Date(startedAt)) throw new Error("Препарат не может быть принят раньше начала приступа.");
  return { medicationId: medication.id, medicationAmount, medicationUnitId, medicationTakenAt };
}

function openHeadacheForm(record = null) {
  document.querySelector("#headache-form").reset(); document.querySelector("#headache-id").value = record?.id || ""; document.querySelector("#headache-form-title").textContent = record ? "Редактировать эпизод" : "Новый эпизод";
  document.querySelector("#headache-error").textContent = ""; refreshDirectoryOptions();
  if (record) {
    const intensityMin = record.intensityMin ?? record.intensity; const intensityMax = record.intensityMax ?? record.intensity;
    document.querySelector("#headache-start-datetime").value = moscowDateTimeValue(record.startedAt);
    document.querySelector("#intensity").value = intensityMax; document.querySelector("#intensity-min").value = intensityMin; document.querySelector("#intensity-max").value = intensityMax; document.querySelector("#headache-variable-intensity").checked = intensityMin !== intensityMax; document.querySelector("#headache-ongoing").checked = record.endedAt === null;
    if (record.endedAt) document.querySelector("#headache-end-datetime").value = moscowDateTimeValue(record.endedAt);
    document.querySelector("#body-part").value = record.bodyPartId || "";
    document.querySelector("#medication").value = record.medicationId || "";
    document.querySelector("#medication-amount").value = formatMedicationAmount(record.medicationAmount); document.querySelector("#medication-unit").value = record.medicationUnitId || "";
    if (record.medicationTakenAt) document.querySelector("#medication-datetime").value = moscowDateTimeValue(record.medicationTakenAt); document.querySelector("#headache-comment").value = record.comment;
  } else { document.querySelector("#body-part").value = directoryItemById(state.data.bodyParts, "body-head")?.id || state.data.bodyParts[0]?.id || ""; setMoscowNow(document.querySelector("#headache-start-datetime")); document.querySelector("#headache-ongoing").checked = true; document.querySelector("#intensity").value = document.querySelector("#intensity-min").value = document.querySelector("#intensity-max").value = 5; }
  syncVariableIntensity(); syncMedicationDateTime(); syncHeadacheEndFields(); for (const selector of ["#headache-start-datetime", "#headache-end-datetime", "#medication-datetime"]) syncNotFutureConstraint(document.querySelector(selector)); openDialog("#headache-dialog");
}

function measurementTimestamp(prefix) {
  const measuredAt = moscowDateTimeInputToIso(document.querySelector(`#${prefix}-datetime`).value);
  if (isFuture(measuredAt)) throw new Error("Дата и время измерения не могут быть в будущем.");
  return measuredAt;
}

async function savePressure(event) {
  event.preventDefault(); const button = document.querySelector("#pressure-save"); if (button.disabled) return; const errorNode = document.querySelector("#pressure-error"); errorNode.textContent = "";
  const values = { systolic: finiteInteger(document.querySelector("#systolic").value), diastolic: finiteInteger(document.querySelector("#diastolic").value) };
  if (values.systolic === null || values.systolic < 30 || values.systolic > 300) { errorNode.textContent = "Допустимое значение давления (верхнее): 30-300"; return; }
  if (values.diastolic === null || values.diastolic < 10 || values.diastolic > 180) { errorNode.textContent = "Допустимое значение давления (нижнее): 10-180"; return; }
  if (values.systolic <= values.diastolic && !state.pressureWarningAccepted) { const warning = document.querySelector("#pressure-warning"); warning.textContent = "Значение выглядит необычным. Проверьте ввод и нажмите «Сохранить» ещё раз, если всё верно."; warning.hidden = false; state.pressureWarningAccepted = true; return; }
  try {
    const record = { id: document.querySelector("#pressure-id").value || makeId(), measuredAt: measurementTimestamp("pressure"), editedAt: new Date().toISOString(), ...values, comment: document.querySelector("#pressure-comment").value.trim() };
    setBusy(button, true); await saveRecord(STORES.pressure, record); await closeDialog(document.querySelector("#pressure-dialog")); await refreshData(); handleSuccessfulDataChange("Измерение сохранено");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function savePulse(event) {
  event.preventDefault(); const button = document.querySelector("#pulse-save"); if (button.disabled) return; const errorNode = document.querySelector("#pulse-error"); errorNode.textContent = "";
  const pulse = finiteInteger(document.querySelector("#pulse-value").value);
  if (pulse === null || pulse < 20 || pulse > 400) { errorNode.textContent = "Допустимое значение пульса: 20-400"; return; }
  const context = document.querySelector("#pulse-context").value; if (!PULSE_CONTEXT[context] || context === "unknown") { errorNode.textContent = "Выберите контекст измерения."; return; }
  const optionalPercent = (selector, message, minimum) => { const raw = document.querySelector(selector).value.trim(); if (!raw) return null; const value = finiteInteger(raw); if (value === null || value < minimum || value > 100) throw new Error(message); return value; };
  try {
    const spo2 = optionalPercent("#pulse-spo2", "Допустимое значение SpO2: 1-100", 1); const stress = optionalPercent("#pulse-stress", "Допустимое значение стресса: 0-100", 0);
    const record = { id: document.querySelector("#pulse-id").value || makeId(), measuredAt: measurementTimestamp("pulse"), editedAt: new Date().toISOString(), pulse, context, spo2, stress, comment: document.querySelector("#pulse-comment").value.trim() };
    setBusy(button, true); await saveRecord(STORES.pulse, record); await closeDialog(document.querySelector("#pulse-dialog")); await refreshData(); handleSuccessfulDataChange("Пульс сохранён");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function saveGlucose(event) {
  event.preventDefault(); const button = document.querySelector("#glucose-save"); if (button.disabled) return; const errorNode = document.querySelector("#glucose-error"); errorNode.textContent = "";
  const raw = document.querySelector("#glucose-value").value.trim();
  if (!/^\d+([.,]\d)?$/.test(raw)) { errorNode.textContent = "Допустимое значение глюкозы: 1,0-40,0"; return; }
  const value = Number(raw.replace(",", ".")); if (value < 1 || value > 40) { errorNode.textContent = "Допустимое значение глюкозы: 1,0-40,0"; return; }
  try {
    const record = { id: document.querySelector("#glucose-id").value || makeId(), measuredAt: measurementTimestamp("glucose"), editedAt: new Date().toISOString(), value, format: document.querySelector("#glucose-format").value, context: document.querySelector("#glucose-context").value, comment: document.querySelector("#glucose-comment").value.trim() };
    setBusy(button, true); await saveRecord(STORES.glucose, record); await closeDialog(document.querySelector("#glucose-dialog")); await refreshData(); handleSuccessfulDataChange("Глюкоза сохранена");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function saveWeight(event) {
  event.preventDefault(); const button = document.querySelector("#weight-save"); if (button.disabled) return; const errorNode = document.querySelector("#weight-error"); errorNode.textContent = "";
  const weightResult = validateWeightInput(document.querySelector("#weight-value").value); if (weightResult.error) { errorNode.textContent = weightResult.error; return; } const { weight } = weightResult;
  try {
    const record = { id: document.querySelector("#weight-id").value || makeId(), measuredAt: measurementTimestamp("weight"), editedAt: new Date().toISOString(), weight, comment: document.querySelector("#weight-comment").value.trim() };
    setBusy(button, true); await saveRecord(STORES.weight, record); await closeDialog(document.querySelector("#weight-dialog")); await refreshData(); handleSuccessfulDataChange("Вес сохранён");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function saveTemperature(event) {
  event.preventDefault(); const button = document.querySelector("#temperature-save"); if (button.disabled) return; const errorNode = document.querySelector("#temperature-error"); errorNode.textContent = "";
  const raw = document.querySelector("#temperature-value").value.trim(); const temperature = Number(raw.replace(",", "."));
  if (!/^\d+(?:[.,]\d)?$/.test(raw) || !Number.isFinite(temperature) || temperature < 13 || temperature > 47) { errorNode.textContent = "Допустимая температура: 13,0–47,0 °C, один знак после запятой или точки"; return; }
  try {
    const record = { id: document.querySelector("#temperature-id").value || makeId(), measuredAt: measurementTimestamp("temperature"), editedAt: new Date().toISOString(), temperature };
    setBusy(button, true); await saveRecord(STORES.temperature, record); await closeDialog(document.querySelector("#temperature-dialog")); await refreshData(); handleSuccessfulDataChange("Температура сохранена");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function saveSteps(event) {
  event.preventDefault(); const button = document.querySelector("#steps-save"); if (button.disabled) return; const errorNode = document.querySelector("#steps-error"); errorNode.textContent = "";
  const measuredDate = document.querySelector("#steps-date").value; const steps = finiteInteger(document.querySelector("#steps-value").value);
  if (!validDiaryDate(measuredDate)) { errorNode.textContent = "Укажите корректную дату, не позднее сегодняшней."; return; }
  if (steps === null || steps < 1 || steps > 300000) { errorNode.textContent = "Допустимое количество шагов: 1–300000"; return; }
  try {
    const record = { id: document.querySelector("#steps-id").value || makeId(), measuredDate, editedAt: new Date().toISOString(), steps };
    setBusy(button, true); await saveRecord(STORES.steps, record); await closeDialog(document.querySelector("#steps-dialog")); await refreshData(); handleSuccessfulDataChange("Шаги сохранены");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function saveHeadache(event) {
  event.preventDefault();
  const button = document.querySelector("#headache-save"); if (button.disabled) return; const errorNode = document.querySelector("#headache-error"); errorNode.textContent = "";
  try {
    const bodyPart = selectedBodyPart(); if (checkOngoingPain()) return;
    const period = readHeadachePeriod(); const intensity = readIntensityRange(); const medication = readMedication(period.startedAt);
    const record = { id: document.querySelector("#headache-id").value || makeId(), bodyPartId: bodyPart.id, ...period, ...intensity, ...medication, editedAt: new Date().toISOString(), comment: document.querySelector("#headache-comment").value.trim() };
    if (hasOngoingPainForBodyPart(state.data.painEpisodes, bodyPart.id, record.id)) throw new Error(`Приступ боли в области «${bodyPart.name}» уже продолжается. Завершите его через редактирование записи.`);
    setBusy(button, true); await saveRecord(STORES.pain, record); await closeDialog(document.querySelector("#headache-dialog")); await refreshData(); handleSuccessfulDataChange("Эпизод боли сохранён");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

function validBirthDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number); const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day && value <= new Date().toISOString().slice(0, 10);
}

function openProfileForm() {
  const profile = state.data.profile; document.querySelector("#profile-form").reset(); document.querySelector("#profile-error").textContent = "";
  document.querySelector("#profile-form-title").textContent = profile ? "Редактировать данные" : "Заполнить данные";
  document.querySelector("#profile-birth-date").max = new Date().toISOString().slice(0, 10);
  if (profile) { document.querySelector("#profile-birth-date").value = profile.birthDate; document.querySelector("#profile-sex").value = profile.sex; document.querySelector("#profile-height").value = formatMetricOneDecimal(profile.heightCm); }
  openDialog("#profile-dialog");
}

async function saveProfileForm(event) {
  event.preventDefault(); const button = document.querySelector("#profile-save"); const errorNode = document.querySelector("#profile-error"); errorNode.textContent = "";
  const birthDate = document.querySelector("#profile-birth-date").value; const sex = document.querySelector("#profile-sex").value; const heightRaw = document.querySelector("#profile-height").value.trim(); const heightCm = Number(heightRaw.replace(",", "."));
  if (!validBirthDate(birthDate)) { errorNode.textContent = "Укажите реальную дату рождения, не позднее сегодняшней."; return; }
  if (!['male', 'female'].includes(sex)) { errorNode.textContent = "Выберите пол."; return; }
  if (!/^\d+(?:[.,]\d)?$/.test(heightRaw) || !Number.isFinite(heightCm) || heightCm < 50 || heightCm > 300) { errorNode.textContent = "Рост должен быть от 50 до 300 см с одним знаком после запятой или точки."; return; }
  try {
    setBusy(button, true); const editedAt = new Date().toISOString(); const profile = { id: "profile", birthDate, sex, heightCm, editedAt };
    await saveProfile(profile);
    await closeDialog(document.querySelector("#profile-dialog")); await refreshData(); updateBirthdayBrand(); handleSuccessfulDataChange("Данные сохранены");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

function renderProfile() {
  elements.profileContent.replaceChildren(); const profile = state.data.profile;
  if (!profile) {
    const card = emptyState("Профиль не заполнен", "Укажите дату рождения, пол и рост.", "👤");
    card.append(el("button", { className: "primary-button profile-edit-button", type: "button", text: "Заполнить данные", onClick: openProfileForm })); elements.profileContent.append(card); return;
  }
  const current = newestWeight(); const bmi = current ? calculateBmi(current.weight, profile.heightCm) : null;
  const items = [profileItem("Дата рождения", formatDateOnly(profile.birthDate)), profileItem("Возраст", ageLabel(profileAge())), profileItem("Пол", profile.sex === "male" ? "мужской" : "женский"), profileItem("Рост", `${formatMetricOneDecimal(profile.heightCm)} см`)];
  if (current) items.push(profileItem("Текущий вес", `${formatMetricOneDecimal(current.weight)} кг`), profileItem("ИМТ", formatOneDecimal(bmi)));
  const grid = el("dl", { className: "profile-grid" }, items);
  const editButton = el("button", { className: "profile-edit-fab", type: "button", onClick: openProfileForm, attrs: { "aria-label": "Редактировать данные" } }, [el("span", { text: "✏️", attrs: { "aria-hidden": "true" } })]);
  elements.profileContent.append(grid, editButton);
  if (current) elements.profileContent.append(el("p", { className: "medical-note", text: "ИМТ рассчитывается при отображении. Диапазоны справочные и не являются диагнозом." }));
}

function profileItem(label, value) { return el("div", { className: "profile-item" }, [el("dt", { text: label }), el("dd", { text: value })]); }

function updateDirectoryItemExpirationRemaining() {
  const input = document.querySelector("#directory-item-expiration-date");
  const output = document.querySelector("#directory-item-expiration-remaining");
  const text = formatMedicationExpirationRemaining(input.value, getMoscowFields().date);
  output.textContent = text || ""; output.hidden = !text; output.classList.toggle("expired", text === "Срок истёк");
}

function openDirectoryItemForm(kind, item = null, quickAdd = false) {
  state.directoryContext = { kind, quickAdd };
  document.querySelector("#directory-item-form").reset(); document.querySelector("#directory-item-error").textContent = "";
  document.querySelector("#directory-item-id").value = item?.id || "";
  document.querySelector("#directory-item-name").value = item?.name || "";
  const expirationField = document.querySelector("#directory-item-expiration-field");
  expirationField.hidden = kind !== "medications";
  document.querySelector("#directory-item-expiration-date").value = kind === "medications" ? item?.expirationDate || "" : "";
  updateDirectoryItemExpirationRemaining();
  const label = kind === "bodyParts" ? "Название" : "Название препарата";
  document.querySelector("#directory-item-label").textContent = label;
  document.querySelector("#directory-item-title").textContent = item ? kind === "bodyParts" ? "Переименовать" : "Редактировать препарат" : kind === "bodyParts" ? "Добавить часть тела" : "Добавить препарат";
  document.querySelector("#directory-item-save").textContent = item ? "Сохранить" : "Добавить";
  openDialog("#directory-item-dialog"); document.querySelector("#directory-item-name").focus();
}

async function saveDirectoryItemForm(event) {
  event.preventDefault(); const context = state.directoryContext; if (!context) return;
  const errorNode = document.querySelector("#directory-item-error"); const button = document.querySelector("#directory-item-save"); errorNode.textContent = "";
  try {
    const name = validateDirectoryName(document.querySelector("#directory-item-name").value, context.kind === "bodyParts" ? "Название" : "Название препарата");
    const id = document.querySelector("#directory-item-id").value || makeId();
    const expirationDate = context.kind === "medications" ? document.querySelector("#directory-item-expiration-date").value || null : undefined;
    const duplicate = state.data[context.kind].find((item) => item.id !== id && normalizedNameKey(item.name) === normalizedNameKey(name));
    if (duplicate) throw new Error(context.kind === "bodyParts" ? "Такая часть тела уже есть в справочнике." : "Такой препарат уже есть в справочнике.");
    setBusy(button, true); await saveDirectoryItem(context.kind === "bodyParts" ? STORES.bodyParts : STORES.medications, { id, name, expirationDate, editedAt: new Date().toISOString() });
    await closeDialog(document.querySelector("#directory-item-dialog")); await refreshData();
    if (context.quickAdd) {
      if (context.kind === "medications" && document.querySelector("#medication-course-dialog").open) { document.querySelector("#course-medication").value = id; syncCourseMedicationFields(); }
      else { document.querySelector(context.kind === "bodyParts" ? "#body-part" : "#medication").value = id; if (context.kind === "medications") syncMedicationDateTime(); }
    }
    if (context.quickAdd) { markBackupPending(); showToast(context.kind === "bodyParts" ? "Часть тела сохранена" : "Препарат сохранён"); }
    else handleSuccessfulDataChange(context.kind === "bodyParts" ? "Часть тела сохранена" : "Препарат сохранён");
    if (state.directoryContext === context) state.directoryContext = null;
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function deleteDirectoryItem(kind, item) {
  const used = kind === "bodyParts" ? state.data.painEpisodes.some((episode) => episode.bodyPartId === item.id) : state.data.painEpisodes.some((episode) => episode.medicationId === item.id);
  if (used) { showToast(`${kind === "bodyParts" ? "Часть тела" : "Препарат"} «${item.name}» уже используется в истории.`); return; }
  if (!await confirmAction({ title: `Удалить «${item.name}»?`, message: "Элемент будет удалён из справочника.", confirmLabel: "Удалить" })) return;
  try { await deleteRecord(kind === "bodyParts" ? STORES.bodyParts : STORES.medications, item.id); await refreshData(); handleSuccessfulDataChange("Элемент справочника удалён"); } catch (error) { showToast(`Не удалось удалить: ${error.message}`); }
}

function directoryItems(kind) {
  const list = el("ul", { className: "directory-list" });
  for (const item of state.data[kind]) {
    const status = kind === "medications" ? medicationExpirationStatus(item.expirationDate, getMoscowFields().date) : null;
    const displayedName = status ? formatMedicationNameWithExpiration(item, getMoscowFields().date) : item.name;
    list.append(el("li", {}, [el("span", { text: displayedName, attrs: status ? { title: status.label } : {} }), el("div", { className: "directory-actions" }, [
    el("button", { type: "button", text: "✏️", onClick: () => openDirectoryItemForm(kind, item), attrs: { "aria-label": `Изменить ${item.name}`, title: "Изменить" } }),
    el("button", { type: "button", text: "🗑️", onClick: () => deleteDirectoryItem(kind, item), attrs: { "aria-label": `Удалить ${item.name}`, title: "Удалить" } })
  ])]));
  }
  return list;
}

function openDirectory(kind) {
  if (!DIRECTORY_META[kind] || state.activeDirectory === kind) return;
  if (!applyingNavigationState) saveCurrentNavigationScroll();
  state.activeDirectory = kind; renderDirectories(); scrollPageToTop();
  if (!applyingNavigationState) pushNavigationEntry();
}

function renderDirectories() {
  if (!elements.directoriesContent) return;
  const kind = state.activeDirectory;
  elements.directoriesHeading.textContent = kind ? DIRECTORY_META[kind].title : "Справочники";
  elements.directoriesBack.hidden = !kind; elements.directoryAdd.hidden = !kind;
  if (kind) {
    const items = directoryItems(kind);
    elements.directoriesContent.replaceChildren(items.childElementCount ? items : emptyState("Справочник пуст", "Добавьте первый элемент.", DIRECTORY_META[kind].icon));
    return;
  }
  const list = el("div", { className: "directory-picker-list" });
  for (const [directoryKind, meta] of Object.entries(DIRECTORY_META)) list.append(el("button", { className: "directory-choice", type: "button", onClick: () => openDirectory(directoryKind) }, [
    el("span", { className: "directory-choice-icon", text: meta.icon, attrs: { "aria-hidden": "true" } }),
    el("span", { className: "directory-choice-main" }, [el("strong", { text: meta.title }), el("small", { text: directoryCountLabel(state.data[directoryKind].length) })]),
    el("span", { className: "directory-choice-chevron", text: "›", attrs: { "aria-hidden": "true" } })
  ]));
  elements.directoriesContent.replaceChildren(list);
}

function confirmAction({ title, message, confirmLabel = "Подтвердить", confirmClass = "danger-button" }) {
  const dialog = document.querySelector("#confirm-dialog"); const confirmButton = document.querySelector("#confirm-ok"); document.querySelector("#confirm-title").textContent = title; document.querySelector("#confirm-message").textContent = message; confirmButton.textContent = confirmLabel; confirmButton.className = confirmClass; openDialog("#confirm-dialog");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, shouldClose = true) => {
      if (settled) return;
      settled = true;
      document.querySelector("#confirm-ok").removeEventListener("click", ok); document.querySelector("#confirm-cancel").removeEventListener("click", cancel); dialog.removeEventListener("close", closed);
      if (shouldClose) closeDialog(dialog).then(() => resolve(value));
      else resolve(value);
    };
    const ok = () => finish(true); const cancel = () => finish(false); const closed = () => finish(false, false);
    document.querySelector("#confirm-ok").addEventListener("click", ok); document.querySelector("#confirm-cancel").addEventListener("click", cancel); dialog.addEventListener("close", closed);
  });
}

async function handleDiaryAction(event) {
  const button = event.target.closest("[data-action]"); if (!button) return; const { action, kind, id } = button.dataset;
  const record = state.data[COLLECTION_BY_KIND[kind]]?.find((item) => item.id === id); if (!record) return;
  if (action === "edit") { ({ pressure: openPressureForm, pulse: openPulseForm, pain: openHeadacheForm, glucose: openGlucoseForm, weight: openWeightForm, temperature: openTemperatureForm, steps: openStepsForm })[kind](record); return; }
  if (action === "delete") {
    if (!await confirmAction({ title: "Удалить эту запись?", message: "Это действие нельзя отменить.", confirmLabel: "Удалить" })) return;
    try { await deleteRecord(STORE_BY_KIND[kind], id); await refreshData(); handleSuccessfulDataChange("Запись удалена"); } catch (error) { showToast(`Не удалось удалить: ${error.message}`); }
  }
}

function statCard(label, value, note = "", wide = false, child = null) {
  return el("div", { className: `stat-card${wide ? " wide" : ""}` }, [el("span", { className: "stat-label", text: label }), el("strong", { className: "stat-value", text: value ?? "—" }), note ? el("small", { className: "stat-note", text: note }) : null, child]);
}

function distributionCard(label, items) {
  return el("div", { className: "stat-card wide distribution-card" }, [
    el("span", { className: "stat-label", text: label }),
    el("ul", { className: "distribution-list" }, items.map(([name, count]) => el("li", {}, [el("span", { text: name }), el("strong", { text: String(count) })])))
  ]);
}

function overviewCard(metric, icon, title, value, count, note = "") {
  return el("button", { className: "overview-card", type: "button", dataset: { metric }, attrs: { "aria-label": `${title}: ${value}. Открыть подробную статистику` } }, [
    el("span", { className: "overview-icon", text: icon, attrs: { "aria-hidden": "true" } }), el("span", { className: "overview-main" }, [el("strong", { text: title }), el("span", { className: "overview-value", text: value }), el("small", { text: `${recordCountLabel(count)}${note ? ` · ${note}` : ""}` })]), el("span", { className: "overview-chevron", text: "›", attrs: { "aria-hidden": "true" } })
  ]);
}

function observeChart(canvas, draw) { draw(); if ("ResizeObserver" in window) { const observer = new ResizeObserver(debounce(draw, 80)); observer.observe(canvas); state.chartObservers.push(observer); } }
function chart(title, ariaLabel, items, series, legend = []) {
  const canvas = el("canvas", { attrs: { role: "img", "aria-label": ariaLabel } });
  const section = el("section", { className: "chart-card" }, [el("h3", { text: title }), legend.length ? el("div", { className: "chart-legend" }, legend.map((item) => el("span", { className: "legend-key", text: item.label, attrs: { style: `--key: var(${item.color})` } }))) : null, canvas]);
  requestAnimationFrame(() => observeChart(canvas, () => drawTimeChart(canvas, items, series))); return section;
}

function renderOverview(bounds) {
  const filtered = filterDataForPeriod(state.data, bounds); const p = pressureStats(filtered.pressureMeasurements); const q = pulseStats(filtered.pulseMeasurements); const g = glucoseStats(filtered.glucoseMeasurements); const w = weightStats(filtered.weightMeasurements); const t = temperatureStats(filtered.temperatureMeasurements); const s = stepsStats(filtered.stepsMeasurements); const h = painStats(filtered.painEpisodes, new Date(), state.data);
  const pulseContexts = new Set(filtered.pulseMeasurements.map((item) => item.context || "unknown"));
  let glucoseNote = ""; let glucoseValue = g ? `${formatGlucose(g.average)} ммоль/л` : "—";
  if (g) {
    const contexts = new Set(filtered.glucoseMeasurements.map((item) => item.context)); const formats = new Set(filtered.glucoseMeasurements.map((item) => item.format));
    if (contexts.size !== 1 || formats.size !== 1) { glucoseNote = "смешанные условия — среднее скрыто"; glucoseValue = "—"; }
  }
  elements.statsContent.append(el("div", { className: "overview-grid" }, [
    overviewCard("pain", "⚡", "Боль", h ? (h.averageIntensityMin === h.averageIntensityMax ? String(h.averageIntensityMax) : `${h.averageIntensityMin}–${h.averageIntensityMax}`) : "—", filtered.painEpisodes.length, h ? `${h.days} дн. с болью` : ""),
    overviewCard("pressure", "🩺", "Давление", p ? `${p.avgSystolic} / ${p.avgDiastolic}` : "—", filtered.pressureMeasurements.length),
    overviewCard("pulse", "💓", "Пульс", q ? `${q.average} уд/мин` : "—", filtered.pulseMeasurements.length, q && pulseContexts.size === 1 ? PULSE_CONTEXT[[...pulseContexts][0]].toLowerCase() : q ? "смешанные контексты" : ""),
    overviewCard("glucose", "🩸", "Глюкоза", glucoseValue, filtered.glucoseMeasurements.length, glucoseNote),
    overviewCard("weight", "⚖️", "Вес", w ? `${formatMetricOneDecimal(w.current.weight)} кг` : "—", filtered.weightMeasurements.length),
    overviewCard("temperature", "🌡️", "Температура", t ? `${formatMetricOneDecimal(t.current.temperature)} °C` : "—", filtered.temperatureMeasurements.length),
    overviewCard("steps", "👟", "Шаги", s ? `${s.current.steps} шагов` : "—", filtered.stepsMeasurements.length)
  ]));
}

function detailHeading(title, subtitle = "") { elements.statsContent.append(el("div", { className: "detail-heading" }, [el("h3", { text: title }), subtitle ? el("p", { className: "muted", text: subtitle }) : null])); }

function renderPressureStatistics(bounds) {
  const items = filterDataForPeriod(state.data, bounds).pressureMeasurements; const stats = pressureStats(items); detailHeading("Давление");
  if (!stats) { elements.statsContent.append(emptyState("За выбранный период данных нет", "Добавьте измерения или выберите другой период.", "📊")); return; }
  elements.statsContent.append(el("div", { className: "stats-grid" }, [statCard("Среднее верхнее", String(stats.avgSystolic)), statCard("Среднее нижнее", String(stats.avgDiastolic)), statCard("Верхнее min / max", `${stats.minSystolic} / ${stats.maxSystolic}`), statCard("Нижнее min / max", `${stats.minDiastolic} / ${stats.maxDiastolic}`), statCard("Измерений", String(stats.count), "", true)]));
  elements.statsContent.append(chart("Давление во времени", "График верхнего и нижнего давления", items, [{ value: (item) => item.systolic, color: "--pressure", fallback: "#2c6fbb" }, { value: (item) => item.diastolic, color: "--primary", fallback: "#167b68" }], [{ label: "Верхнее", color: "--pressure" }, { label: "Нижнее", color: "--primary" }]));
}

function renderPulseStatistics(bounds) {
  const items = filterDataForPeriod(state.data, bounds).pulseMeasurements; const stats = pulseStats(items); detailHeading("Пульс");
  if (!stats) { elements.statsContent.append(emptyState("За выбранный период данных нет", "Добавьте измерения или выберите другой период.", "📊")); return; }
  const contexts = new Set(items.map((item) => item.context || "unknown")); const allResting = contexts.size === 1 && contexts.has("resting");
  const statuses = items.map(evaluatePulseRecord); const counts = Object.fromEntries(["normal", "low", "high", "critical", "insufficient"].map((level) => [level, statuses.filter((item) => item.level === level).length]));
  const averageNote = allResting ? "Измерения в покое" : contexts.size > 1 ? "Смешанные контексты" : PULSE_CONTEXT[[...contexts][0]];
  elements.statsContent.append(el("div", { className: "stats-grid" }, [statCard("Средний пульс", `${stats.average} уд/мин`, averageNote), statCard("Минимум / максимум", `${stats.min} / ${stats.max}`), statCard("Измерений", String(stats.count)), distributionCard("Распределение по нормам", [["Норма", counts.normal], ["Ниже нормы", counts.low], ["Выше нормы", counts.high], ["Критические", counts.critical], ["Без оценки", counts.insufficient]])]));
  elements.statsContent.append(chart("Пульс во времени", "График пульса", items, [{ value: (item) => item.pulse, color: "--pulse", fallback: "#b34d68" }]));
  const spo2Items = items.filter((item) => Number.isInteger(item.spo2));
  const stressItems = items.filter((item) => Number.isInteger(item.stress));
  if (spo2Items.length) elements.statsContent.append(chart("SpO2 по времени", "График SpO2", spo2Items, [{ value: (item) => item.spo2, color: "--primary", fallback: "#167b68" }]));
  if (stressItems.length) elements.statsContent.append(chart("Стресс по времени", "График стресса", stressItems, [{ value: (item) => item.stress, color: "--warning", fallback: "#d59616" }]));
}

function glucoseFilters() {
  const wrapper = el("div", { className: "stat-filters" }, [
    el("label", { className: "field" }, [el("span", { text: "Контекст" }), el("select", { id: "glucose-context-filter" }, [el("option", { value: "all", text: "Все контексты" }), ...Object.entries(GLUCOSE_CONTEXT).map(([value, text]) => el("option", { value, text }))])]),
    el("label", { className: "field" }, [el("span", { text: "Формат" }), el("select", { id: "glucose-format-filter" }, [el("option", { value: "all", text: "Все форматы" }), ...Object.entries(GLUCOSE_FORMAT).map(([value, text]) => el("option", { value, text }))])])
  ]);
  wrapper.querySelector("#glucose-context-filter").value = state.glucoseContext; wrapper.querySelector("#glucose-format-filter").value = state.glucoseFormat; return wrapper;
}

function renderGlucoseStatistics(bounds) {
  detailHeading("Глюкоза", "Фильтры не выполняют пересчёт между форматами."); elements.statsSubfilters.hidden = false; elements.statsSubfilters.replaceChildren(glucoseFilters());
  let items = filterDataForPeriod(state.data, bounds).glucoseMeasurements;
  if (state.glucoseContext !== "all") items = items.filter((item) => item.context === state.glucoseContext);
  if (state.glucoseFormat !== "all") items = items.filter((item) => item.format === state.glucoseFormat);
  if (!items.length) { elements.statsContent.append(emptyState("За выбранный период данных нет", "Измените фильтры или добавьте измерение.", "📊")); return; }
  const formats = new Set(items.map((item) => item.format)); const contexts = new Set(items.map((item) => item.context)); const mixedFormats = formats.size > 1; const mixedContexts = contexts.size > 1;
  const stats = glucoseStats(items, (item) => evaluateGlucose({ ...item, age: profileAge() }));
  if (mixedFormats) elements.statsContent.append(el("p", { className: "form-warning", text: "В выборке есть эквивалент плазмы и цельная кровь. Общие среднее, минимум, максимум и график скрыты — выберите один формат." }));
  else if (mixedContexts) elements.statsContent.append(el("p", { className: "form-warning", text: "Контексты измерений различаются. Общее медицинское среднее скрыто; выберите один контекст для сопоставимого среднего." }));
  const average = mixedFormats || mixedContexts ? "—" : `${formatGlucose(stats.average)} ммоль/л`;
  elements.statsContent.append(el("div", { className: "stats-grid" }, [statCard("Измерений", String(stats.count)), statCard("Среднее", average, mixedContexts ? "Разные контексты" : mixedFormats ? "Разные форматы" : ""), statCard("Минимум / максимум", mixedFormats ? "—" : `${formatGlucose(stats.min)} / ${formatGlucose(stats.max)}`), distributionCard("Распределение по нормам", [["Ниже диапазона", stats.statusCounts.low], ["В диапазоне", stats.statusCounts.normal], ["Выше диапазона", stats.statusCounts.high], ["Критические", stats.statusCounts.critical], ["Без оценки", stats.statusCounts.insufficient]]), statCard("Формат результата", [...formats].map((value) => GLUCOSE_FORMAT[value]).join(" · "), "", true)]));
  if (!mixedFormats) elements.statsContent.append(chart("Глюкоза во времени", "График глюкозы", items, [{ value: (item) => item.value, color: "--glucose", fallback: "#8b4cb8" }]));
}

function renderWeightStatistics(bounds) {
  const items = filterDataForPeriod(state.data, bounds).weightMeasurements; const stats = weightStats(items); detailHeading("Вес");
  if (!stats) { elements.statsContent.append(emptyState("За выбранный период данных нет", "Добавьте измерения или выберите другой период.", "📊")); return; }
  const bmi = calculateBmi(stats.current.weight, state.data.profile?.heightCm);
  elements.statsContent.append(el("div", { className: "stats-grid" }, [statCard("Текущий вес", `${formatMetricOneDecimal(stats.current.weight)} кг`), statCard("Изменение за период", formatSigned(stats.change, " кг")), statCard("Минимум / максимум", `${formatMetricOneDecimal(stats.min)} / ${formatMetricOneDecimal(stats.max)} кг`), statCard("Текущий ИМТ", formatOneDecimal(bmi))]));
  elements.statsContent.append(chart("Вес во времени", "График веса", items, [{ value: (item) => item.weight, color: "--weight", fallback: "#2e8b69" }]));
  if (state.data.profile?.heightCm) elements.statsContent.append(chart("ИМТ во времени", "График индекса массы тела", items, [{ value: (item) => calculateBmi(item.weight, state.data.profile.heightCm), color: "--primary", fallback: "#167b68" }]));
}

function renderTemperatureStatistics(bounds) {
  const items = filterDataForPeriod(state.data, bounds).temperatureMeasurements; const stats = temperatureStats(items); detailHeading("Температура");
  if (!stats) { elements.statsContent.append(emptyState("За выбранный период данных нет", "Добавьте измерения или выберите другой период.", "📊")); return; }
  elements.statsContent.append(el("div", { className: "stats-grid" }, [statCard("Последнее измерение", `${formatMetricOneDecimal(stats.current.temperature)} °C`), statCard("Средняя температура", `${formatMetricOneDecimal(stats.average)} °C`), statCard("Минимум / максимум", `${formatMetricOneDecimal(stats.min)} / ${formatMetricOneDecimal(stats.max)} °C`), statCard("Измерений", String(stats.count))]));
  elements.statsContent.append(chart("Температура во времени", "График температуры", items, [{ value: (item) => item.temperature, color: "--temperature", fallback: "#b84b3f" }]));
}

function renderStepsStatistics(bounds) {
  const items = filterDataForPeriod(state.data, bounds).stepsMeasurements; const stats = stepsStats(items); detailHeading("Шаги");
  if (!stats) { elements.statsContent.append(emptyState("За выбранный период данных нет", "Добавьте шаги или выберите другой период.", "📊")); return; }
  elements.statsContent.append(el("div", { className: "stats-grid" }, [statCard("Последняя запись", `${stats.current.steps} шагов`), statCard("Среднее за день", `${stats.average} шагов`), statCard("Минимум / максимум", `${stats.min} / ${stats.max} шагов`), statCard("Всего за период", `${stats.total} шагов`), statCard("Дней с данными", String(stats.count), "", true)]));
  elements.statsContent.append(chart("Шаги по дням", "График шагов по дням", items, [{ value: (item) => item.steps, color: "--steps", fallback: "#376c9f" }]));
}

function painBodyPartFilter() {
  const select = el("select", { id: "pain-body-part-filter" }, [el("option", { value: "all", text: "Все части тела" }), ...state.data.bodyParts.map((item) => el("option", { value: item.id, text: item.name }))]);
  select.value = state.painBodyPart; return el("div", { className: "stat-filters" }, [el("label", { className: "field" }, [el("span", { text: "Часть тела" }), select])]);
}

function renderPainStatistics(bounds) {
  detailHeading("Боль"); elements.statsSubfilters.hidden = false; elements.statsSubfilters.replaceChildren(painBodyPartFilter());
  let items = filterDataForPeriod(state.data, bounds).painEpisodes;
  if (state.painBodyPart !== "all") items = items.filter((item) => item.bodyPartId === state.painBodyPart);
  const stats = painStats(items, new Date(), state.data);
  if (!stats) { elements.statsContent.append(emptyState("За выбранный период данных нет", "Добавьте эпизоды или выберите другой период.", "📊")); return; }
  elements.statsContent.append(el("div", { className: "stats-grid" }, [statCard("Приступов боли", String(stats.count)), statCard("Дней с болью", String(stats.days)), statCard("Средняя интенсивность (min)", String(stats.averageIntensityMin)), statCard("Средняя интенсивность (max)", String(stats.averageIntensityMax)), statCard("Общая минимальная интенсивность", String(stats.minIntensity)), statCard("Общая максимальная интенсивность", String(stats.maxIntensity)), statCard("Средняя продолжительность", stats.averageDuration === null ? "—" : formatDuration(stats.averageDuration), stats.completedCount ? `По ${stats.completedCount} завершённым эпизодам` : "Нет завершённых эпизодов"), statCard("Макс. продолжительность", stats.maxDuration === null ? "—" : formatDuration(stats.maxDuration)), statCard("Суммарная продолжительность", formatDuration(stats.totalDuration), "Только завершённые эпизоды"), statCard("Продолжаются сейчас", String(stats.ongoingCount)), statCard("Принятых доз", String(stats.medicationDoseCount))]));
  elements.statsContent.append(chart("Интенсивность во времени", "График минимальной и максимальной интенсивности боли", items, [{ value: (item) => item.intensityMin, color: "--headache", fallback: "#97602a" }, { value: (item) => item.intensityMax, color: "--danger", fallback: "#b23535" }], [{ label: "Минимальная", color: "--headache" }, { label: "Максимальная", color: "--danger" }]));
  const bodyList = el("ul", { className: "medication-list" }); for (const [name, count] of stats.bodyParts) bodyList.append(el("li", {}, [el("span", { text: name }), el("strong", { text: String(count) })])); elements.statsContent.append(el("section", { className: "chart-card" }, [el("h3", { text: "Приступы по частям тела" }), bodyList]));
  const list = el("ul", { className: "medication-list" }); for (const [name, info] of stats.medications) { const doses = [...info.units.entries()].map(([unitId, amount]) => `${formatMedicationAmount(amount)} ${UNIT_BY_ID[unitId]?.short || ""}`.trim()).join(" · "); list.append(el("li", {}, [el("span", { text: name }), el("strong", { text: `${info.episodes}${doses ? ` · ${doses}` : ""}` })])); } elements.statsContent.append(el("section", { className: "chart-card" }, [el("h3", { text: "Лекарства" }), list]));
}

function renderStatistics() {
  for (const observer of state.chartObservers) observer.disconnect(); state.chartObservers = []; elements.statsContent.replaceChildren(); elements.statsSubfilters.replaceChildren(); elements.statsSubfilters.hidden = true; elements.statsBack.hidden = state.statsMetric === "overview";
  let bounds; try { bounds = getPeriodBounds(elements.statsPeriod.value, elements.periodStart.value, elements.periodEnd.value); } catch (error) { elements.statsContent.append(emptyState("Некорректный период", error.message, "⚠️")); return; }
  if (bounds.incomplete) { elements.statsContent.append(emptyState("Выберите обе даты", "Укажите начало и окончание своего периода.", "📊")); return; } if (bounds.invalid) { elements.statsContent.append(emptyState("Некорректный период", "Дата начала не может быть позже даты окончания.", "⚠️")); return; }
  ({ overview: renderOverview, pressure: renderPressureStatistics, pulse: renderPulseStatistics, glucose: renderGlucoseStatistics, weight: renderWeightStatistics, temperature: renderTemperatureStatistics, steps: renderStepsStatistics, pain: renderPainStatistics })[state.statsMetric](bounds);
}

function medicationName(id) { return directoryItemById(state.data.medications, id)?.name || "Неизвестное лекарство"; }
function medicationNameWithExpiration(id) {
  const medication = directoryItemById(state.data.medications, id);
  return formatMedicationNameWithExpiration(medication, getMoscowFields().date);
}
function formatLocalDate(date) { return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00Z`)); }
function formatCompactLocalDate(date) { return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00Z`)); }
function shiftDate(date, days) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }

function medicationDateControls() {
  const today = getMoscowFields().date;
  return el("div", { className: "medication-date-controls" }, [
    el("button", { className: "date-arrow", type: "button", attrs: { "aria-label": "Предыдущий день" }, onClick: () => { state.medicationDate = shiftDate(state.medicationDate, -1); renderMedications(); } }, [el("span", { className: "date-arrow-icon", text: "◀️", attrs: { "aria-hidden": "true" } })]),
    el("label", { className: "field medication-date-field" }, [
      el("span", { className: "medication-date-input-shell" }, [
        el("span", { className: "medication-date-value", text: formatCompactLocalDate(state.medicationDate), attrs: { "aria-hidden": "true" } }),
        el("input", { type: "date", value: state.medicationDate, attrs: { "aria-label": "Выбранная дата" }, onChange: (event) => { state.medicationDate = event.currentTarget.value || today; renderMedications(); } })
      ])
    ]),
    el("button", { className: "date-arrow", type: "button", attrs: { "aria-label": "Следующий день" }, onClick: () => { state.medicationDate = shiftDate(state.medicationDate, 1); renderMedications(); } }, [el("span", { className: "date-arrow-icon", text: "▶️", attrs: { "aria-hidden": "true" } })])
  ]);
}

function medicationScheduleRow(item) {
  const course = item.course;
  return el("article", { className: "medication-schedule-row" }, [
    el("time", { className: "medication-time", text: item.time }),
    el("div", { className: "medication-schedule-main" }, [el("strong", { text: medicationName(course.medicationId) }), el("span", { text: formatMedicationDose(course.amount, course.unitId) }), el("small", { text: FOOD_RELATIONS[course.foodRelation] })])
  ]);
}

function renderMedicationToday() {
  const today = getMoscowFields().date;
  const root = el("div", { className: "medication-today" }, [medicationDateControls(), el("p", { className: "selected-date-label", text: formatLocalDate(state.medicationDate) })]);
  if (state.medicationDate !== today) root.append(el("button", { className: "add-button medication-today-fab", type: "button", attrs: { "aria-label": "К сегодня" }, onClick: () => { state.medicationDate = today; renderMedications(); } }, [el("span", { text: "📅", attrs: { "aria-hidden": "true" } })]));
  const groups = buildDaySchedule(state.data.medicationCourses, [], state.medicationDate, state.data.medications); let count = 0;
  for (const part of DAY_PARTS) {
    if (!groups[part.id].length) continue; count += groups[part.id].length;
    root.append(el("section", { className: `day-part-card ${part.id}` }, [el("h3", {}, [el("span", { text: part.icon, attrs: { "aria-hidden": "true" } }), document.createTextNode(part.label)]), ...groups[part.id].map(medicationScheduleRow)]));
  }
  if (!count) root.append(emptyState("Нет приёмов", "На выбранную дату активных назначений нет.", "💊"));
  elements.medicationsContent.replaceChildren(root);
}

function coursePeriodLabel(course) { return `${formatLocalDate(course.startDate)} — ${course.endDate ? formatLocalDate(course.endDate) : "без даты окончания"}`; }

function medicationCourseActionButton(label, symbol, action, courseId) {
  return el("button", { className: "card-action", type: "button", text: symbol, dataset: { medicationAction: action, courseId }, attrs: { "aria-label": label } });
}

function courseCard(course) {
  const completed = isCourseCompletedOn(course, getMoscowFields().date);
  const medication = directoryItemById(state.data.medications, course.medicationId);
  const expirationStatus = medicationExpirationStatus(medication?.expirationDate, getMoscowFields().date);
  return el("article", { className: "course-card" }, [
    el("div", { className: "course-card-heading" }, [el("div", {}, [el("h3", { text: medicationNameWithExpiration(course.medicationId), attrs: { title: expirationStatus.label } }), el("p", { text: `${formatMedicationDose(course.amount, course.unitId)} · ${FOOD_RELATIONS[course.foodRelation]}` })])]),
    el("div", { className: "card-actions" }, [medicationCourseActionButton("Редактировать курс", "✏️", "edit-course", course.id), medicationCourseActionButton("Удалить курс", "🗑️", "delete-course", course.id)]),
    el("p", { className: "course-period", text: coursePeriodLabel(course) }),
    el("div", { className: "course-times" }, course.schedule.map((time) => el("span", { text: time }))),
    course.comment ? el("p", { className: "entry-comment", text: course.comment }) : null,
    !completed ? el("button", { className: "secondary-button course-complete-button", type: "button", text: "Завершить", dataset: { medicationAction: "archive-course", courseId: course.id } }) : null
  ]);
}

function renderMedicationCourses() {
  const today = getMoscowFields().date;
  const list = el("div", { className: "course-list" });
  for (const course of state.data.medicationCourses.filter((item) => !isCourseCompletedOn(item, today))) list.append(courseCard(course));
  elements.medicationsContent.replaceChildren(list.childElementCount ? list : emptyState("Активных курсов пока нет", "Добавьте первое назначение лекарства.", "💊"));
}

function renderMedicationHistory() {
  const today = getMoscowFields().date;
  const list = el("div", { className: "medication-history" });
  for (const course of state.data.medicationCourses.filter((item) => isCourseCompletedOn(item, today))) list.append(courseCard(course));
  elements.medicationsContent.replaceChildren(list.childElementCount ? list : emptyState("История пуста", "Завершённые курсы появятся здесь.", "🕘"));
}

function renderMedications() {
  if (!elements.medicationsContent) return;
  document.querySelectorAll("[data-medication-tab]").forEach((button) => { const active = button.dataset.medicationTab === state.medicationTab; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
  elements.medicationCourseAdd.hidden = state.medicationTab !== "courses";
  ({ today: renderMedicationToday, courses: renderMedicationCourses, history: renderMedicationHistory })[state.medicationTab]();
}

function sortCourseScheduleRows() {
  const schedule = document.querySelector("#course-schedule");
  const rows = [...schedule.querySelectorAll(".schedule-row")].sort((left, right) => {
    const leftTime = left.querySelector("input[type=time]").value || "99:99"; const rightTime = right.querySelector("input[type=time]").value || "99:99";
    return leftTime.localeCompare(rightTime);
  });
  schedule.append(...rows);
}

function addCourseScheduleTime(value = "09:00") {
  const timeInput = el("input", { type: "time", value, required: true, attrs: { "aria-label": "Время приёма" }, onBlur: sortCourseScheduleRows });
  const row = el("div", { className: "schedule-row" }, [el("label", { className: "field" }, [timeInput]), el("button", { type: "button", attrs: { "aria-label": "Удалить время", title: "Удалить" }, onClick: () => { if (document.querySelectorAll("#course-schedule .schedule-row").length > 1) { row.remove(); sortCourseScheduleRows(); } } }, [el("span", { className: "schedule-delete-icon", text: "🗑️", attrs: { "aria-hidden": "true" } })])]);
  document.querySelector("#course-schedule").append(row); sortCourseScheduleRows();
}

function refreshCourseMedicationOptions() { document.querySelector("#course-medication").replaceChildren(el("option", { value: "", text: "Выберите" }), ...state.data.medications.map((item) => el("option", { value: item.id, text: item.name }))); }
function syncCourseMedicationFields() {
  const medication = directoryItemById(state.data.medications, document.querySelector("#course-medication").value);
  const amount = document.querySelector("#course-amount"); const unit = document.querySelector("#course-unit");
  amount.disabled = unit.disabled = !medication;
  if (!medication) { amount.value = ""; unit.value = ""; }
}
function openMedicationCourseForm(course = null) {
  document.querySelector("#medication-course-form").reset(); document.querySelector("#medication-course-error").textContent = ""; document.querySelector("#medication-course-warning").hidden = true;
  document.querySelector("#medication-course-id").value = course?.id || ""; document.querySelector("#medication-course-title").textContent = course ? "Редактировать курс" : "Новый курс";
  refreshCourseMedicationOptions(); document.querySelector("#course-medication").value = course?.medicationId || ""; document.querySelector("#course-amount").value = course ? formatMedicationAmount(course.amount) : ""; document.querySelector("#course-unit").value = course?.unitId || ""; syncCourseMedicationFields();
  document.querySelector("#course-start").value = course?.startDate || getMoscowFields().date; document.querySelector("#course-end").value = course?.endDate || ""; document.querySelector("#course-food").value = course?.foodRelation || "any"; document.querySelector("#course-comment").value = course?.comment || "";
  document.querySelector("#course-schedule").replaceChildren(); for (const time of course?.schedule || ["09:00"]) addCourseScheduleTime(time); openDialog("#medication-course-dialog");
}

function selectedCourseMedication() {
  const item = directoryItemById(state.data.medications, document.querySelector("#course-medication").value);
  if (!item) throw new Error("Выберите лекарство из справочника или добавьте его кнопкой «+»."); return item;
}

async function saveMedicationCourse(event) {
  event.preventDefault(); const errorNode = document.querySelector("#medication-course-error"); const button = document.querySelector("#medication-course-save"); errorNode.textContent = "";
  try {
    const current = state.data.medicationCourses.find((item) => item.id === document.querySelector("#medication-course-id").value); const medication = selectedCourseMedication();
    const record = validateMedicationCourse({ id: current?.id || makeId(), medicationId: medication.id, amount: document.querySelector("#course-amount").value, unitId: document.querySelector("#course-unit").value, startDate: document.querySelector("#course-start").value, endDate: document.querySelector("#course-end").value || null, schedule: [...document.querySelectorAll("#course-schedule input[type=time]")].map((input) => input.value), foodRelation: document.querySelector("#course-food").value, comment: document.querySelector("#course-comment").value.trim(), archived: current?.archived || false, editedAt: new Date().toISOString() }, new Set(state.data.medications.map((item) => item.id)));
    const duplicate = state.data.medicationCourses.find((item) => item.id !== record.id && !item.archived && item.medicationId === record.medicationId && (!item.endDate || item.endDate >= record.startDate) && (!record.endDate || record.endDate >= item.startDate));
    if (duplicate && !event.submitter?.dataset.confirmed) { const warning = document.querySelector("#medication-course-warning"); warning.textContent = "У этого лекарства уже есть пересекающийся активный курс. Нажмите «Сохранить» ещё раз, чтобы продолжить."; warning.hidden = false; button.dataset.confirmed = "true"; return; }
    setBusy(button, true); await saveRecord(STORES.medicationCourses, record); delete button.dataset.confirmed; await closeDialog(document.querySelector("#medication-course-dialog")); await refreshData(); handleSuccessfulDataChange("Курс лекарства сохранён");
  } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function handleMedicationAction(event) {
  const button = event.target.closest("[data-medication-action]"); if (!button) return; const course = state.data.medicationCourses.find((item) => item.id === button.dataset.courseId);
  if (button.dataset.medicationAction === "edit-course" && course) openMedicationCourseForm(course);
  if (button.dataset.medicationAction === "delete-course" && course && await confirmAction({ title: "Удалить курс?", message: "Курс будет удалён без возможности восстановления.", confirmLabel: "Удалить" })) { await deleteMedicationCourse(course.id); await refreshData(); handleSuccessfulDataChange("Курс удалён"); }
  if (button.dataset.medicationAction === "archive-course" && course && await confirmAction({ title: "Завершить курс?", message: "Курс будет перенесён в историю.", confirmLabel: "Завершить", confirmClass: "primary-button" })) { const today = getMoscowFields().date; const endDate = course.startDate > today ? null : (!course.endDate || course.endDate > today ? today : course.endDate); await saveRecord(STORES.medicationCourses, { ...course, endDate, archived: true, editedAt: new Date().toISOString() }); await refreshData(); handleSuccessfulDataChange("Курс завершён"); }
}

function switchView(view, { scrollToTop = true } = {}) {
  const views = { diary: elements.diaryView, stats: elements.statsView, settings: elements.settingsView, profile: elements.profileView, interface: elements.interfaceView, backup: elements.backupView, about: elements.aboutView, changes: elements.changesView, description: elements.descriptionView, features: elements.featuresView, directories: elements.directoriesView, medications: elements.medicationsView };
  if (!views[view]) return;
  state.activeView = view;
  for (const [name, section] of Object.entries(views)) section.hidden = name !== view;
  const settingsActive = view === "settings" || SETTINGS_CHILD_VIEWS.has(view);
  document.querySelectorAll("[data-view]").forEach((button) => { const active = button.dataset.view === view || (button.hasAttribute("data-settings-root") && settingsActive); button.classList.toggle("active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  const aboutButton = document.querySelector("#brand-icon-container");
  const aboutActive = view === "about" || ABOUT_CHILD_VIEWS.has(view);
  aboutButton.classList.toggle("active", aboutActive);
  if (aboutActive) aboutButton.setAttribute("aria-current", "page"); else aboutButton.removeAttribute("aria-current");
  if (view === "stats") { state.statsMetric = "overview"; renderStatistics(); }
  if (view === "profile") renderProfile();
  if (view === "interface") renderInterfaceSettings();
  if (view === "backup") document.querySelector("#data-error").textContent = "";
  if (view === "about" || ABOUT_CHILD_VIEWS.has(view)) { ensureAppInfo(); ensureChanges(); }
  if (view === "directories") { state.activeDirectory = null; renderDirectories(); }
  if (view === "medications") { state.medicationTab = "today"; state.medicationDate = getMoscowFields().date; renderMedications(); }
  if (scrollToTop) scrollPageToTop();
}

function navigateRootView(view) {
  if (!ROOT_VIEWS.has(view)) return;
  const depth = navigationState()?.depth || 0;
  saveCurrentNavigationScroll();
  switchView(view);
  if (depth > 0) {
    pendingRootView = view;
    history.go(-depth);
  } else replaceNavigationEntry(0);
}

function navigateToSettings() {
  if (state.activeView === "settings") return;
  if (SETTINGS_CHILD_VIEWS.has(state.activeView)) { navigateBack(); return; }
  saveCurrentNavigationScroll();
  switchView("settings");
  pushNavigationEntry();
}

function navigateToAbout() {
  if (state.activeView === "about") return;
  if (ABOUT_CHILD_VIEWS.has(state.activeView)) { navigateBack(); return; }
  saveCurrentNavigationScroll();
  switchView("about");
  pushNavigationEntry();
}

function navigateToSettingsChild(view) {
  if (!SETTINGS_CHILD_VIEWS.has(view) || state.activeView === view) return;
  saveCurrentNavigationScroll();
  switchView(view);
  pushNavigationEntry();
}

function navigateToAboutChild(view) {
  if (!ABOUT_CHILD_VIEWS.has(view) || state.activeView === view) return;
  saveCurrentNavigationScroll();
  switchView(view);
  pushNavigationEntry();
}

function navigateBack() {
  if ((navigationState()?.depth || 0) > 0) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    saveCurrentNavigationScroll();
    history.back();
  }
}

function applyNavigationState(next) {
  if (!next || next.version !== 1) return;
  const validView = ROOT_VIEWS.has(next.view) || next.view === "settings" || next.view === "about" || SETTINGS_CHILD_VIEWS.has(next.view) || ABOUT_CHILD_VIEWS.has(next.view);
  if (!validView) return;
  applyingNavigationState = true;
  try {
    switchView(next.view, { scrollToTop: false });
    if (next.view === "directories" && (next.directory === null || DIRECTORY_META[next.directory])) {
      state.activeDirectory = next.directory;
      renderDirectories();
    }
    if (next.view === "stats" && ["overview", "pressure", "pulse", "glucose", "weight", "temperature", "steps", "pain"].includes(next.statsMetric)) {
      state.statsMetric = next.statsMetric;
      renderStatistics();
    }
    restorePageScroll(next.scrollTop);
  } finally { applyingNavigationState = false; }
}

function handleNavigationPop(event) {
  if (document.querySelector("dialog[open]") && modalNavigationState) {
    history.pushState({ [APP_NAVIGATION_KEY]: modalNavigationState }, "");
    return;
  }
  if (pendingRootView) {
    const view = pendingRootView;
    pendingRootView = null;
    applyingNavigationState = true;
    try { switchView(view); }
    finally { applyingNavigationState = false; }
    replaceNavigationEntry(0);
    return;
  }
  applyNavigationState(event.state?.[APP_NAVIGATION_KEY]);
}

function initializeNavigation() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  replaceNavigationEntry(0);
  window.addEventListener("popstate", handleNavigationPop);
}

async function handleImportFile(event) {
  const errorNode = document.querySelector("#data-error"); errorNode.textContent = "";
  try {
    const data = await parseBackupFile(event.target.files[0]); const conflicts = await countImportConflicts(data); state.pendingImport = data;
    const summary = [[data.profile ? 1 : 0, "профиль"], [data.pressureMeasurements.length, "давление"], [data.pulseMeasurements.length, "пульс"], [data.painEpisodes.length, "боль"], [data.glucoseMeasurements.length, "глюкоза"], [data.weightMeasurements.length, "вес"], [data.temperatureMeasurements.length, "температура"], [data.stepsMeasurements.length, "шаги"], [data.bodyParts.length, "части тела"], [data.medications.length, "лекарства"], [data.medicationCourses.length, "курсы"], [data.medicationIntakes.length, "приёмы"]];
    document.querySelector("#import-summary").replaceChildren(...summary.map(([count, label]) => el("div", {}, [el("strong", { text: String(count) }), el("span", { text: label })])), el("div", { className: "wide" }, [el("strong", { text: String(conflicts) }), el("span", { text: "совпадений ID" })]));
    openDialog("#import-dialog");
  } catch (error) { showError(errorNode, error); } finally { event.target.value = ""; }
}

async function mergeImport() {
  if (!state.pendingImport) return; const button = document.querySelector("#import-merge"); const errorNode = document.querySelector("#import-error"); errorNode.textContent = ""; setBusy(button, true, "Импорт…");
  try { const importedSettings = state.pendingImport.uiSettings; const result = await importWithUiSettings(importedSettings, () => mergeData(state.pendingImport)); state.pendingImport = null; await closeDialog(document.querySelector("#import-dialog")); await refreshData(); handleSuccessfulDataChange(`Импорт завершён · обновлено ${result.imported}`); } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

async function replaceImport() {
  if (!state.pendingImport) return; if (!await confirmAction({ title: "Заменить все данные?", message: "Все текущие данные будут заменены данными из резервной копии. Это действие нельзя отменить.", confirmLabel: "Заменить" })) return;
  const button = document.querySelector("#import-replace"); const errorNode = document.querySelector("#import-error"); errorNode.textContent = ""; setBusy(button, true, "Импорт…");
  try { const importedSettings = state.pendingImport.uiSettings; await importWithUiSettings(importedSettings, () => replaceAllData(state.pendingImport)); state.pendingImport = null; await closeDialog(document.querySelector("#import-dialog")); await refreshData(); clearBackupPending(); showToast("Данные полностью восстановлены"); } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); }
}

function updateOnlineStatus() { elements.offlineBanner.hidden = navigator.onLine; }
async function savePromptedBackup() { const button = document.querySelector("#backup-save"); const errorNode = document.querySelector("#backup-prompt-error"); errorNode.textContent = ""; setBusy(button, true, "Подготовка…"); try { const completed = await exportJson(state.data, state.uiSettings); if (!completed) { errorNode.textContent = "Сохранение отменено. Можно повторить или выбрать «Позже»."; return; } clearBackupPending(); await closeDialog(document.querySelector("#backup-prompt-dialog")); showToast("Резервная копия сохранена"); } catch (error) { showError(errorNode, error); } finally { setBusy(button, false); } }
async function postponeBackupPrompt() { const suppress = document.querySelector("#backup-dont-remind").checked; if (suppress) dismissBackupReminder(); else clearBackupReminderDismissed(); await closeDialog(document.querySelector("#backup-prompt-dialog")); showToast(suppress ? "Не напомним до следующего изменения данных" : "Напомним о резервной копии позже"); }
async function requestPersistentStorage() { if (!navigator.storage?.persist) return; try { elements.storageWarning.hidden = await navigator.storage.persist(); } catch { elements.storageWarning.hidden = false; } }
function markApplicationUpdateReady() {
  const version = document.querySelector("#app-version"); version.disabled = false; version.classList.add("update-ready"); version.setAttribute("aria-label", `${version.textContent}: доступна новая версия, нажмите для обновления`); version.title = "Нажмите, чтобы обновить приложение";
}

function applyApplicationUpdate() {
  const version = document.querySelector("#app-version");
  if (!version.classList.contains("update-ready")) return;
  version.disabled = true;
  version.setAttribute("aria-label", `${version.textContent}: приложение обновляется`);
  version.title = "Приложение обновляется";
  window.location.reload();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    let hasActiveController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hasActiveController) markApplicationUpdateReady();
      hasActiveController = true;
    });
    try {
      const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" });
      try { await registration.update(); } catch { /* офлайн-запуск использует текущую версию */ }
    } catch { showToast("Не удалось включить офлайн-режим"); }
  });
}

function bindMeasurementConstraints() {
  for (const selector of ["#pressure-datetime", "#pulse-datetime", "#glucose-datetime", "#weight-datetime", "#temperature-datetime", "#headache-start-datetime", "#headache-end-datetime", "#medication-datetime"]) {
    const input = document.querySelector(selector); syncNotFutureConstraint(input); input.addEventListener("focus", () => syncNotFutureConstraint(input));
  }
}

function openEntryTypeDialog() { document.querySelector("#entry-type-error").textContent = ""; openDialog("#entry-type-dialog"); }
function chooseHeadacheEntry() {
  replaceDialog(document.querySelector("#entry-type-dialog"), openHeadacheForm);
}

function bindEvents() {
  syncVisualViewport();
  scheduleSafeTopSync();
  pageScrollContainer()?.addEventListener("scroll", () => {
    if (document.documentElement.classList.contains("modal-open")) scheduleModalBackgroundScrollRestore();
  }, { passive: true });
  document.querySelectorAll('[role="radiogroup"]').forEach((group) => group.addEventListener("keydown", (event) => {
    const current = event.target.closest('[role="radio"]');
    if (!current || !group.contains(current) || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const options = [...group.querySelectorAll('[role="radio"]')]; const index = options.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
    event.preventDefault(); options[nextIndex].focus(); options[nextIndex].click();
  }));
  for (const eventName of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
  document.addEventListener("touchmove", (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
  document.addEventListener("focusin", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("dialog.entry-form-dialog")) return;
    syncEntryKeyboardState();
    setTimeout(() => {
      if (syncEntryKeyboardState()) scheduleFocusedEntryFieldVisibility();
    }, 220);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target instanceof Element && event.target.closest("dialog.entry-form-dialog")) setTimeout(() => {
      if (syncEntryKeyboardState()) scheduleFocusedEntryFieldVisibility();
    });
  });
  if (window.visualViewport) {
    const handleVisualViewportChange = debounce(() => {
      syncVisualViewport();
      if (syncEntryKeyboardState()) scheduleFocusedEntryFieldVisibility();
    }, 80);
    window.visualViewport.addEventListener("resize", handleVisualViewportChange);
    window.visualViewport.addEventListener("scroll", handleVisualViewportChange);
  }
  if (typeof ResizeObserver === "function") {
    const entryContentObserver = new ResizeObserver(() => {
      if (syncEntryKeyboardState()) ensureFocusedEntryFieldVisible();
    });
    document.querySelectorAll("dialog.entry-form-dialog .entry-form-content").forEach((content) => entryContentObserver.observe(content));
  }
  const portraitOrientation = window.matchMedia("(orientation: portrait)");
  const handleOrientationChange = () => {
    const scrollTop = document.documentElement.classList.contains("modal-open") ? modalScrollY : currentPageScrollTop();
    scheduleSafeTopSync();
    scheduleShellLayoutSync(scrollTop);
  };
  if (typeof portraitOrientation.addEventListener === "function") portraitOrientation.addEventListener("change", handleOrientationChange);
  else portraitOrientation.addListener(handleOrientationChange);
  window.addEventListener("orientationchange", handleOrientationChange);
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog")))); document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => {
      clearEntryKeyboardState(dialog);
      queueMicrotask(syncModalState);
    });
    dialog.addEventListener("cancel", (event) => event.preventDefault());
  });
  document.querySelectorAll("dialog.sheet").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(dialog); }));
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => { if (button.dataset.view === "settings") navigateToSettings(); else navigateRootView(button.dataset.view); }));
  document.querySelector("#brand-icon-container").addEventListener("click", navigateToAbout);
  document.querySelectorAll("[data-settings-target]").forEach((button) => button.addEventListener("click", () => navigateToSettingsChild(button.dataset.settingsTarget)));
  document.querySelectorAll("[data-about-target]").forEach((button) => button.addEventListener("click", () => navigateToAboutChild(button.dataset.aboutTarget)));
  document.querySelector("#profile-back").addEventListener("click", navigateBack); document.querySelector("#interface-back").addEventListener("click", navigateBack); document.querySelector("#backup-back").addEventListener("click", navigateBack); document.querySelector("#about-back").addEventListener("click", navigateBack); document.querySelectorAll(".about-child-back").forEach((button) => button.addEventListener("click", navigateBack));
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => { try { persistTheme(button.dataset.themeChoice); showToast("Тема изменена"); } catch (error) { showToast(error.message); } }));
  document.querySelectorAll("[data-interface-choice]").forEach((button) => button.addEventListener("click", () => { try { persistUiSettings({ ...state.uiSettings, interface: button.dataset.interfaceChoice }); showToast("Оформление изменено"); } catch (error) { showToast(error.message); } }));
  document.querySelectorAll("[data-glass-effects-choice]").forEach((button) => button.addEventListener("click", () => { try { persistUiSettings({ ...state.uiSettings, glassEffects: button.dataset.glassEffectsChoice }); showToast("Эффекты Liquid Glass изменены"); } catch (error) { showToast(error.message); } }));
  const glassTransparency = document.querySelector("#glass-transparency");
  glassTransparency.addEventListener("input", (event) => previewGlassTransparency(event.currentTarget));
  glassTransparency.addEventListener("change", (event) => { try { commitGlassTransparency(event.currentTarget); } catch (error) { applyUiSettings(state.uiSettings); renderInterfaceSettings(); showToast(error.message); } });
  glassTransparency.addEventListener("keydown", (event) => { try { handleGlassTransparencyKeydown(event); } catch (error) { applyUiSettings(state.uiSettings); renderInterfaceSettings(); showToast(error.message); } });
  const glassBlurIntensity = document.querySelector("#glass-blur-intensity");
  glassBlurIntensity.addEventListener("input", (event) => previewGlassBlurIntensity(event.currentTarget));
  glassBlurIntensity.addEventListener("change", (event) => { try { commitGlassBlurIntensity(event.currentTarget); } catch (error) { applyUiSettings(state.uiSettings); renderInterfaceSettings(); showToast(error.message); } });
  glassBlurIntensity.addEventListener("keydown", (event) => { try { handleGlassBlurIntensityKeydown(event); } catch (error) { applyUiSettings(state.uiSettings); renderInterfaceSettings(); showToast(error.message); } });

  document.querySelectorAll("[data-medication-tab]").forEach((button) => button.addEventListener("click", () => { state.medicationTab = button.dataset.medicationTab; renderMedications(); }));
  elements.medicationCourseAdd.addEventListener("click", () => openMedicationCourseForm()); elements.medicationsContent.addEventListener("click", handleMedicationAction);
  document.querySelector("#medication-course-form").addEventListener("submit", saveMedicationCourse); document.querySelector("#course-add-time").addEventListener("click", () => addCourseScheduleTime()); document.querySelector("#course-add-medication").addEventListener("click", () => openDirectoryItemForm("medications", null, true));
  document.querySelector("#course-medication").addEventListener("change", syncCourseMedicationFields);
  document.querySelector("#medication-course-form").addEventListener("input", () => { delete document.querySelector("#medication-course-save").dataset.confirmed; document.querySelector("#medication-course-warning").hidden = true; });
  document.querySelectorAll("#diary-filter button").forEach((button) => button.addEventListener("click", () => setDiaryFilter(button.dataset.filter)));
  elements.diaryFilterSelect.addEventListener("change", () => setDiaryFilter(elements.diaryFilterSelect.value));
  elements.loadMore.addEventListener("click", () => { state.diaryLimit += PAGE_SIZE; renderDiary(); }); document.querySelector("#add-button").addEventListener("click", openEntryTypeDialog);
  document.querySelector("#choose-headache").addEventListener("click", chooseHeadacheEntry);
  for (const [selector, opener] of [["#choose-pressure", openPressureForm], ["#choose-pulse", openPulseForm], ["#choose-glucose", openGlucoseForm], ["#choose-weight", openWeightForm], ["#choose-temperature", openTemperatureForm], ["#choose-steps", openStepsForm]]) document.querySelector(selector).addEventListener("click", () => replaceDialog(document.querySelector("#entry-type-dialog"), opener));
  document.querySelector("#pressure-form").addEventListener("submit", savePressure); document.querySelector("#pulse-form").addEventListener("submit", savePulse); document.querySelector("#headache-form").addEventListener("submit", saveHeadache); document.querySelector("#glucose-form").addEventListener("submit", saveGlucose); document.querySelector("#weight-form").addEventListener("submit", saveWeight); document.querySelector("#temperature-form").addEventListener("submit", saveTemperature); document.querySelector("#steps-form").addEventListener("submit", saveSteps); document.querySelector("#profile-form").addEventListener("submit", saveProfileForm);
  document.querySelector("#headache-ongoing").addEventListener("change", () => syncHeadacheEndFields(true)); document.querySelector("#headache-variable-intensity").addEventListener("change", () => syncVariableIntensity(true)); document.querySelector("#medication").addEventListener("change", syncMedicationDateTime);
  document.querySelector("#body-part").addEventListener("change", () => { document.querySelector("#headache-error").textContent = ""; checkOngoingPain(); });
  document.querySelector("#add-body-part").addEventListener("click", () => openDirectoryItemForm("bodyParts", null, true)); document.querySelector("#add-medication").addEventListener("click", () => openDirectoryItemForm("medications", null, true)); document.querySelector("#directory-item-form").addEventListener("submit", saveDirectoryItemForm); document.querySelector("#directory-item-expiration-date").addEventListener("input", updateDirectoryItemExpirationRemaining);
  elements.directoriesBack.addEventListener("click", navigateBack);
  elements.directoryAdd.addEventListener("click", () => { if (state.activeDirectory) openDirectoryItemForm(state.activeDirectory); });
  for (const input of document.querySelectorAll("#intensity, #intensity-min, #intensity-max")) { input.addEventListener("input", (event) => updateIntensityDisplay(event.currentTarget)); input.addEventListener("change", (event) => snapIntensity(event.currentTarget)); input.addEventListener("keydown", handleIntensityKeydown); } document.querySelector("#pressure-form").addEventListener("input", () => { state.pressureWarningAccepted = false; document.querySelector("#pressure-warning").hidden = true; });
  bindMeasurementConstraints(); elements.diaryList.addEventListener("click", handleDiaryAction);
  elements.statsContent.addEventListener("click", (event) => { const card = event.target.closest("[data-metric]"); if (!card || state.statsMetric !== "overview") return; saveCurrentNavigationScroll(); state.statsMetric = card.dataset.metric; renderStatistics(); scrollPageToTop(); pushNavigationEntry(); });
  elements.statsBack.addEventListener("click", navigateBack); elements.statsPeriod.addEventListener("change", () => { elements.customPeriod.hidden = elements.statsPeriod.value !== "custom"; renderStatistics(); }); elements.periodStart.addEventListener("change", renderStatistics); elements.periodEnd.addEventListener("change", renderStatistics);
  elements.statsSubfilters.addEventListener("change", (event) => { if (event.target.id === "glucose-context-filter") state.glucoseContext = event.target.value; if (event.target.id === "glucose-format-filter") state.glucoseFormat = event.target.value; if (event.target.id === "pain-body-part-filter") state.painBodyPart = event.target.value; renderStatistics(); });
  document.querySelector("#export-csv").addEventListener("click", async () => { try { if (await exportCsv(state.data)) showToast("CSV подготовлены"); } catch (error) { showError(document.querySelector("#data-error"), error); } });
  document.querySelector("#export-json").addEventListener("click", async () => { try { if (await exportJson(state.data, state.uiSettings)) { clearBackupPending(); showToast("Резервная копия подготовлена"); } } catch (error) { showError(document.querySelector("#data-error"), error); } });
  document.querySelector("#backup-save").addEventListener("click", savePromptedBackup); document.querySelector("#backup-later").addEventListener("click", postponeBackupPrompt);
  document.querySelector("#app-version").addEventListener("click", applyApplicationUpdate);
  document.querySelector("#import-file").addEventListener("change", handleImportFile); document.querySelector("#import-merge").addEventListener("click", mergeImport); document.querySelector("#import-replace").addEventListener("click", replaceImport); window.addEventListener("online", updateOnlineStatus); window.addEventListener("offline", updateOnlineStatus);
}

async function initialize() {
  renderInterfaceSettings(); renderAppInfo(); ensureAppInfo(); ensureChanges(); initializeNavigation(); bindEvents(); updateOnlineStatus(); registerServiceWorker();
  try { await openDatabase(); await refreshData(); updateBirthdayBrand(); requestPersistentStorage(); showBackupPrompt(); } catch (error) { elements.diaryList.replaceChildren(emptyState("Не удалось открыть локальные данные", `${error.message} Закройте другие вкладки и попробуйте снова.`, "⚠️")); document.querySelector("#add-button").disabled = true; }
}

initialize();

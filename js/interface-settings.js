export const UI_SETTINGS_KEY = "myhealth:ui-settings:v1";
export const UI_THEME_KEY = "myhealth:theme:v1";
export const DEFAULT_THEME = "auto";
export const DEFAULT_GLASS_TRANSPARENCY = 25;
export const DEFAULT_GLASS_EFFECTS = "reduced";
export const DEFAULT_GLASS_BLUR_INTENSITY = 100;
export const MIN_GLASS_TRANSPARENCY = 10;
export const MAX_GLASS_TRANSPARENCY = 60;
export const MIN_GLASS_BLUR_INTENSITY = 25;
export const MAX_GLASS_BLUR_INTENSITY = 100;

const INTERFACES = new Set(["classic", "modern"]);
const GLASS_EFFECTS = new Set(["full", "reduced", "none"]);
const THEMES = new Set(["auto", "light", "dark"]);

export function isValidInterface(value) {
  return INTERFACES.has(value);
}

export function isValidGlassTransparency(value) {
  return Number.isInteger(value) && value >= MIN_GLASS_TRANSPARENCY && value <= MAX_GLASS_TRANSPARENCY;
}

export function isValidGlassEffects(value) {
  return GLASS_EFFECTS.has(value);
}

export function isValidGlassBlurIntensity(value) {
  return Number.isInteger(value) && value >= MIN_GLASS_BLUR_INTENSITY && value <= MAX_GLASS_BLUR_INTENSITY;
}

export function isValidTheme(value) {
  return THEMES.has(value);
}

export function readTheme(storage = globalThis.localStorage) {
  try {
    const theme = storage.getItem(UI_THEME_KEY);
    return isValidTheme(theme) ? theme : null;
  } catch {
    return null;
  }
}

export function saveTheme(theme, storage = globalThis.localStorage) {
  if (!isValidTheme(theme)) throw new Error("Некорректная тема интерфейса.");
  storage.setItem(UI_THEME_KEY, theme);
  return theme;
}

export function initializeTheme({ storage = globalThis.localStorage } = {}) {
  const stored = readTheme(storage);
  return stored || saveTheme(DEFAULT_THEME, storage);
}

export function applyTheme(theme, root = document.documentElement) {
  if (!isValidTheme(theme)) throw new Error("Некорректная тема интерфейса.");
  root.dataset.theme = theme;
  return theme;
}

export function normalizeUiSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isValidInterface(value.interface)) return null;
  return {
    interface: value.interface,
    glassTransparency: isValidGlassTransparency(value.glassTransparency) ? value.glassTransparency : DEFAULT_GLASS_TRANSPARENCY,
    glassEffects: isValidGlassEffects(value.glassEffects) ? value.glassEffects : DEFAULT_GLASS_EFFECTS,
    glassBlurIntensity: isValidGlassBlurIntensity(value.glassBlurIntensity) ? value.glassBlurIntensity : DEFAULT_GLASS_BLUR_INTENSITY
  };
}

export function readUiSettings(storage = globalThis.localStorage) {
  try {
    return normalizeUiSettings(JSON.parse(storage.getItem(UI_SETTINGS_KEY)));
  } catch {
    return null;
  }
}

export function saveUiSettings(settings, storage = globalThis.localStorage) {
  const normalized = normalizeUiSettings(settings);
  if (!normalized) throw new Error("Некорректные настройки интерфейса.");
  storage.setItem(UI_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function applyGlassTransparency(value, root = document.documentElement) {
  const transparency = Number(value);
  if (!Number.isFinite(transparency) || transparency < MIN_GLASS_TRANSPARENCY || transparency > MAX_GLASS_TRANSPARENCY) throw new Error("Некорректная прозрачность стекла.");
  const opacity = 100 - transparency;
  root.style.setProperty("--glass-transparency", `${transparency}%`);
  root.style.setProperty("--glass-opacity", `${opacity}%`);
  root.style.setProperty("--glass-raised-opacity", `${Math.min(96, opacity + 12)}%`);
  root.style.setProperty("--glass-subtle-opacity", `${Math.max(42, opacity - 12)}%`);
  return transparency;
}

export function applyGlassBlurIntensity(value, root = document.documentElement) {
  const intensity = Number(value);
  if (!Number.isFinite(intensity) || intensity < MIN_GLASS_BLUR_INTENSITY || intensity > MAX_GLASS_BLUR_INTENSITY) throw new Error("Некорректная интенсивность размытия.");
  root.style.setProperty("--glass-blur-intensity", `${intensity}%`);
  root.style.setProperty("--glass-blur-scale", String(Number((intensity / 100).toFixed(4))));
  return intensity;
}

function platformEvidence(navigatorLike = {}) {
  const userAgent = String(navigatorLike.userAgent || "");
  const platforms = [navigatorLike.userAgentData?.platform, navigatorLike.platform].filter(Boolean).map(String);
  const platform = platforms.join(" ");
  const maxTouchPoints = Number(navigatorLike.maxTouchPoints || 0);
  const appleMobileUa = /\b(iPhone|iPad|iPod)\b/i.test(userAgent);
  const androidUa = /\bAndroid\b/i.test(userAgent);
  const windowsUa = /\bWindows\b/i.test(userAgent);
  const linuxUa = /\bLinux\b/i.test(userAgent) && !androidUa;
  const macUa = /\bMacintosh|Mac OS X\b/i.test(userAgent);
  const applePlatform = platforms.some((value) => /^(Mac|iPhone|iPad|iPod)/i.test(value));
  const nonApplePlatform = platforms.some((value) => /^(Win|Linux|Android)/i.test(value));
  const appleSignal = appleMobileUa || macUa || applePlatform;
  const nonAppleSignal = androidUa || windowsUa || linuxUa || nonApplePlatform;
  return { appleMobileUa, androidUa, windowsUa, linuxUa, macUa, applePlatform, nonApplePlatform, appleSignal, nonAppleSignal, maxTouchPoints, platform };
}

export function detectInitialInterface(navigatorLike = {}) {
  const evidence = platformEvidence(navigatorLike);
  if (evidence.appleSignal && evidence.nonAppleSignal) return "classic";
  if (evidence.androidUa || evidence.windowsUa || evidence.linuxUa || evidence.nonApplePlatform) return "classic";
  if (evidence.appleMobileUa) return "modern";
  if (evidence.applePlatform || evidence.macUa) {
    // iPadOS can identify itself as MacIntel; both iPadOS and genuine macOS use the modern interface.
    return "modern";
  }
  return "classic";
}

export function initializeUiSettings({ storage = globalThis.localStorage, navigatorLike = globalThis.navigator, detect = detectInitialInterface } = {}) {
  const stored = readUiSettings(storage);
  if (stored) {
    // Rewrite only to repair missing/invalid fields; OS detection is intentionally skipped.
    saveUiSettings(stored, storage);
    return stored;
  }
  const selected = { interface: detect(navigatorLike), glassTransparency: DEFAULT_GLASS_TRANSPARENCY, glassEffects: DEFAULT_GLASS_EFFECTS, glassBlurIntensity: DEFAULT_GLASS_BLUR_INTENSITY };
  return saveUiSettings(selected, storage);
}

export function applyUiSettings(settings, root = document.documentElement) {
  const normalized = normalizeUiSettings(settings);
  if (!normalized) throw new Error("Некорректные настройки интерфейса.");
  root.dataset.interface = normalized.interface;
  root.dataset.glassEffects = normalized.glassEffects;
  applyGlassTransparency(normalized.glassTransparency, root);
  applyGlassBlurIntensity(normalized.glassBlurIntensity, root);
  return normalized;
}

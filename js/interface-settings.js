export const UI_SETTINGS_KEY = "myhealth:ui-settings:v1";
export const DEFAULT_GLASS_TRANSPARENCY = 25;
export const MIN_GLASS_TRANSPARENCY = 10;
export const MAX_GLASS_TRANSPARENCY = 45;

const INTERFACES = new Set(["classic", "modern"]);

export function isValidInterface(value) {
  return INTERFACES.has(value);
}

export function isValidGlassTransparency(value) {
  return Number.isInteger(value) && value >= MIN_GLASS_TRANSPARENCY && value <= MAX_GLASS_TRANSPARENCY;
}

export function normalizeUiSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isValidInterface(value.interface)) return null;
  return {
    interface: value.interface,
    glassTransparency: isValidGlassTransparency(value.glassTransparency) ? value.glassTransparency : DEFAULT_GLASS_TRANSPARENCY
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
    // Rewrite only to repair a missing/invalid transparency value; OS detection is intentionally skipped.
    saveUiSettings(stored, storage);
    return stored;
  }
  const selected = { interface: detect(navigatorLike), glassTransparency: DEFAULT_GLASS_TRANSPARENCY };
  return saveUiSettings(selected, storage);
}

export function applyUiSettings(settings, root = document.documentElement) {
  const normalized = normalizeUiSettings(settings);
  if (!normalized) throw new Error("Некорректные настройки интерфейса.");
  const opacity = 100 - normalized.glassTransparency;
  root.dataset.interface = normalized.interface;
  root.style.setProperty("--glass-transparency", `${normalized.glassTransparency}%`);
  root.style.setProperty("--glass-opacity", `${opacity}%`);
  root.style.setProperty("--glass-raised-opacity", `${Math.min(96, opacity + 12)}%`);
  root.style.setProperty("--glass-subtle-opacity", `${Math.max(42, opacity - 12)}%`);
  return normalized;
}

const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUILD_DATE_PATTERN = /^(\d{2})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validBuildDate(value) {
  if (!nonEmptyString(value)) return false;
  const match = BUILD_DATE_PATTERN.exec(value.trim());
  if (!match) return false;
  const [, day, month, year, hour, minute] = match.map(Number);
  const date = new Date(2000 + year, month - 1, day, hour, minute);
  return date.getFullYear() === 2000 + year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute;
}

export function parseAppInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректные метаданные приложения.");
  if (!nonEmptyString(value.version) || !SEMANTIC_VERSION_PATTERN.test(value.version.trim())) throw new Error("Некорректная версия приложения.");
  if (!validBuildDate(value.buildDate)) throw new Error("Некорректная дата сборки приложения.");
  if (value.change !== 0 && value.change !== 1) throw new Error("Некорректный режим обновления изменений.");
  if (Object.keys(value).some((key) => !["version", "buildDate", "change"].includes(key))) throw new Error("Некорректные метаданные приложения: неизвестные поля.");

  return Object.freeze({
    version: value.version.trim(),
    buildDate: value.buildDate.trim(),
    change: value.change
  });
}

export function parseChangeMarkdown(value) {
  if (typeof value !== "string") throw new Error("Некорректный файл изменений.");
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Изменения");
  if (heading < 0) throw new Error("В CHANGE.md отсутствует раздел «Изменения».");
  const changes = lines.slice(heading + 1).map((line) => /^\s*\d+\.\s+(.+?)\s*$/.exec(line)?.[1]).filter(Boolean);
  if (!changes.length) throw new Error("В CHANGE.md отсутствует список изменений.");
  return Object.freeze(changes);
}

export async function fetchAppInfo(fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== "function") throw new Error("Загрузка метаданных приложения недоступна.");
  const response = await fetchImplementation("./app-info.json");
  if (!response?.ok) throw new Error("Не удалось загрузить метаданные приложения.");
  return parseAppInfo(await response.json());
}

export function createAppInfoLoader(fetchImplementation = globalThis.fetch) {
  let request = null;
  return () => {
    if (!request) request = fetchAppInfo(fetchImplementation);
    return request;
  };
}

export function createChangeLoader(fetchImplementation = globalThis.fetch) {
  let request = null;
  return () => {
    if (!request) request = (async () => {
      if (typeof fetchImplementation !== "function") throw new Error("Загрузка изменений приложения недоступна.");
      const response = await fetchImplementation("./CHANGE.md");
      if (!response?.ok) throw new Error("Не удалось загрузить изменения приложения.");
      return parseChangeMarkdown(await response.text());
    })();
    return request;
  };
}

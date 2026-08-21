export const DEFAULT_BODY_PARTS = Object.freeze([
  ["body-head", "Голова"],
  ["body-neck", "Шея"],
  ["body-back", "Спина"],
  ["body-chest", "Грудь"],
  ["body-abdomen", "Живот"],
  ["body-arm", "Рука"],
  ["body-leg", "Нога"],
  ["body-joints", "Суставы"]
].map(([id, name]) => Object.freeze({ id, name })));

export const MEDICATION_UNITS = Object.freeze([
  { id: "piece", name: "Штука", short: "шт." },
  { id: "tablet", name: "Таблетка", short: "табл." },
  { id: "ampoule", name: "Ампула", short: "амп." },
  { id: "drop", name: "Капля", short: "кап." },
  { id: "teaspoon", name: "Чайная ложка", short: "ч. л." },
  { id: "tablespoon", name: "Столовая ложка", short: "ст. л." },
  { id: "milligram", name: "Миллиграмм", short: "мг" },
  { id: "milliliter", name: "Миллилитр", short: "мл" }
].map(Object.freeze));

export const UNIT_BY_ID = Object.freeze(Object.fromEntries(MEDICATION_UNITS.map((unit) => [unit.id, unit])));
export const DIRECTORY_NAME_MAX_LENGTH = 100;
export const MEDICATION_AMOUNT_MIN = 0.1;
export const MEDICATION_AMOUNT_MAX = 999.9;

export function normalizeDirectoryName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizedNameKey(value) {
  return normalizeDirectoryName(value).toLocaleLowerCase("ru-RU");
}

export function validateDirectoryName(value, label = "Название") {
  const name = normalizeDirectoryName(value);
  if (!name) throw new Error(`${label} не может быть пустым.`);
  if (name.length > DIRECTORY_NAME_MAX_LENGTH) throw new Error(`${label} не может быть длиннее ${DIRECTORY_NAME_MAX_LENGTH} символов.`);
  return name;
}

export function stableNameId(prefix, value) {
  const text = normalizedNameKey(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export function parseMedicationAmount(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !/^\d+(?:[.,]\d)?$/.test(raw)) throw new Error("Допустимое количество лекарства: 0,1-999,9");
  const amount = Number(raw.replace(",", "."));
  if (!Number.isFinite(amount) || amount < MEDICATION_AMOUNT_MIN || amount > MEDICATION_AMOUNT_MAX) throw new Error("Допустимое количество лекарства: 0,1-999,9");
  return amount;
}

export function formatMedicationAmount(value) {
  if (!Number.isFinite(value)) return "";
  return Number(value).toFixed(1).replace(/\.0$/, "").replace(".", ",");
}

export function formatMedicationDose(amount, unitId) {
  const unit = UNIT_BY_ID[unitId];
  return Number.isFinite(amount) && unit ? `${formatMedicationAmount(amount)} ${unit.short}` : "";
}

export function directoryItemById(items, id) {
  return (items || []).find((item) => item.id === id) || null;
}

export function hasOngoingPainForBodyPart(items, bodyPartId, excludedId = null) {
  return Boolean(bodyPartId) && (items || []).some((item) => item.id !== excludedId && item.bodyPartId === bodyPartId && item.endedAt === null);
}

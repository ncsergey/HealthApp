export const STATUS_LEVELS = Object.freeze({
  CRITICAL: "critical",
  LOW: "low",
  HIGH: "high",
  NORMAL: "normal",
  INSUFFICIENT: "insufficient"
});

export const MEDICAL_RANGES = Object.freeze({
  bmi: { criticalLow: 16, normalLow: 18.5, normalHigh: 24.9, criticalHigh: 40 },
  pressure: {
    systolic: { criticalLow: 70, normalLow: 90, normalHigh: 129, criticalHigh: 180 },
    diastolic: { criticalLow: 40, normalLow: 60, normalHigh: 84, criticalHigh: 120 }
  },
  restingPulse: { criticalLow: 40, normalLow: 60, normalHigh: 100, criticalHigh: 180 },
  glucosePlasma: {
    criticalLow: 2.2,
    criticalHigh: 20,
    fasting: { low: 3.9, high: 5.5 },
    beforeMeal: { low: 3.9, high: 6.1 },
    after1h: { low: 3.9, high: 7.8 },
    after2h: { low: 3.9, high: 7.8 }
  }
});

const LABELS = Object.freeze({
  critical: ["Критическое значение", "⚠️"],
  low: ["Ниже диапазона", "⬇️"],
  high: ["Выше диапазона", "⬆️"],
  normal: ["Норма", "✅"],
  insufficient: ["Недостаточно данных", "⚪"]
});

const CRITICAL_GUIDANCE = "Повторите измерение и при плохом самочувствии обратитесь за медицинской помощью";

function result(level, explanation, missingReason = null) {
  const [text, emoji] = LABELS[level];
  return { level, text, emoji, explanation, missingReason };
}

export function insufficient(reason, explanation = reason) {
  return result(STATUS_LEVELS.INSUFFICIENT, explanation, reason);
}

export function ageOnDate(birthDate, at = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate || "")) return null;
  const [year, month, day] = birthDate.split("-").map(Number);
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  let age = date.getUTCFullYear() - year;
  const beforeBirthday = date.getUTCMonth() + 1 < month || (date.getUTCMonth() + 1 === month && date.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

export function isBirthdayOnDate(birthDate, dateKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(birthDate || "") && /^\d{4}-\d{2}-\d{2}$/.test(dateKey || "") && birthDate.slice(5) === dateKey.slice(5);
}

export function calculateBmi(weightKg, heightCm) {
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm) || weightKg <= 0 || heightCm <= 0) return null;
  return Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10;
}

export function evaluateBmi({ bmi, age }) {
  if (!Number.isFinite(bmi)) return insufficient("Нет роста или веса", "Укажите рост и добавьте измерение веса");
  if (!Number.isFinite(age)) return insufficient("Возраст неизвестен", "Укажите дату рождения");
  if (age < 18) return insufficient("Возраст младше 18 лет", "Для детей нужны возрастно-половые таблицы ИМТ");
  const range = MEDICAL_RANGES.bmi;
  if (bmi < range.criticalLow || bmi >= range.criticalHigh) return result(STATUS_LEVELS.CRITICAL, CRITICAL_GUIDANCE);
  if (bmi < range.normalLow) return result(STATUS_LEVELS.LOW, "Значение ниже справочного диапазона ИМТ взрослых");
  if (bmi <= range.normalHigh) return result(STATUS_LEVELS.NORMAL, "Значение в справочном диапазоне ИМТ взрослых");
  return result(STATUS_LEVELS.HIGH, "Значение выше справочного диапазона ИМТ взрослых");
}

function evaluateBounded(value, range, label) {
  if (!Number.isFinite(value)) return insufficient(`Нет значения: ${label}`);
  if (value <= range.criticalLow || value >= range.criticalHigh) return result(STATUS_LEVELS.CRITICAL, CRITICAL_GUIDANCE);
  if (value < range.normalLow) return result(STATUS_LEVELS.LOW, `${label}: ниже справочного диапазона`);
  if (value <= range.normalHigh) return result(STATUS_LEVELS.NORMAL, `${label}: в справочном диапазоне`);
  return result(STATUS_LEVELS.HIGH, `${label}: выше справочного диапазона`);
}

export function evaluatePressurePart(kind, value) {
  const labels = { systolic: "Верхнее давление", diastolic: "Нижнее давление" };
  const range = MEDICAL_RANGES.pressure[kind];
  return range ? evaluateBounded(value, range, labels[kind]) : insufficient("Неизвестный показатель давления");
}

const PRIORITY = { critical: 4, high: 3, low: 3, normal: 2, insufficient: 1 };

export function evaluatePressure(systolic, diastolic) {
  const systolicStatus = evaluatePressurePart("systolic", systolic);
  const diastolicStatus = evaluatePressurePart("diastolic", diastolic);
  const overall = PRIORITY[systolicStatus.level] >= PRIORITY[diastolicStatus.level] ? systolicStatus : diastolicStatus;
  return { ...overall, systolic: systolicStatus, diastolic: diastolicStatus };
}

export function evaluatePulse(value, { restingKnown = false, contextKnown = false, age = null } = {}) {
  if (!Number.isFinite(age) || age < 18) return insufficient("Нет применимого взрослого диапазона", "Нужны возраст и взрослый справочный диапазон");
  if (!restingKnown) return contextKnown ? insufficient("Без оценки вне покоя", "Нормы применяются только к пульсу взрослого человека в покое") : insufficient("Контекст покоя неизвестен", "Пульс оценивается только у взрослого человека в покое");
  return evaluateBounded(value, MEDICAL_RANGES.restingPulse, "Пульс в покое");
}

export function evaluateGlucose({ value, format, context, age, pregnancy = false, diabetes = false }) {
  if (!Number.isFinite(value)) return insufficient("Нет значения глюкозы");
  if (!Number.isFinite(age)) return insufficient("Возраст неизвестен", "Укажите дату рождения");
  if (age < 18) return insufficient("Возраст младше 18 лет", "Для детей нужны отдельные диапазоны глюкозы");
  if (pregnancy) return insufficient("Беременность требует отдельного диапазона");
  if (diabetes) return insufficient("При диабете нужен индивидуальный целевой диапазон");
  if (format !== "plasma") return insufficient("Формат цельной крови не поддержан", "Подтверждённый диапазон для цельной крови не задан; пересчёт не выполняется");
  if (context === "random") return insufficient("Случайное измерение", "Без дополнительного медицинского контекста случайное измерение не оценивается");
  const range = MEDICAL_RANGES.glucosePlasma;
  const contextRange = range[context];
  if (!contextRange) return insufficient("Неизвестен контекст измерения");
  if (value <= range.criticalLow || value >= range.criticalHigh) return result(STATUS_LEVELS.CRITICAL, CRITICAL_GUIDANCE);
  if (value < contextRange.low) return result(STATUS_LEVELS.LOW, "Значение ниже справочного диапазона для выбранного контекста");
  if (value <= contextRange.high) return result(STATUS_LEVELS.NORMAL, "Значение в справочном диапазоне для выбранного контекста");
  return result(STATUS_LEVELS.HIGH, "Значение выше справочного диапазона для выбранного контекста");
}

export function statusPriority(status) {
  return PRIORITY[status?.level] || 0;
}

export const MEDICAL_REFERENCE_NOTE = "Диапазоны справочные и не являются диагнозом.";

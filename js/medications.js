import { UNIT_BY_ID, parseMedicationAmount } from "./pain.js";

export const FOOD_RELATIONS = Object.freeze({
  before: "До еды", during: "Во время еды", after: "После еды", any: "Независимо от еды"
});
const FOOD_RELATION_SORT_ORDER = Object.freeze({ before: 0, during: 1, after: 2, any: 3 });
const LATIN_NAME_COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const CYRILLIC_NAME_COLLATOR = new Intl.Collator("ru", { sensitivity: "base", numeric: true });

export const MEDICATION_EXPIRATION_THRESHOLDS = Object.freeze({ soonDays: 30, mediumDays: 90, comfortableDays: 180, yearDays: 365 });

export const DAY_PARTS = Object.freeze([
  { id: "night", label: "Ночь", icon: "🌙" },
  { id: "morning", label: "Утро", icon: "🌅" },
  { id: "day", label: "День", icon: "☀️" },
  { id: "evening", label: "Вечер", icon: "🌆" }
]);

export function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function dateOnlyDayNumber(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function medicationExpirationStatus(expirationDate, today) {
  if (!expirationDate || !isValidDateOnly(expirationDate)) return { id: "unknown", emoji: "❓", label: "Срок годности не указан" };
  if (!isValidDateOnly(today)) throw new Error("Некорректная текущая дата.");
  const daysRemaining = dateOnlyDayNumber(expirationDate) - dateOnlyDayNumber(today);
  if (daysRemaining < 0) return { id: "expired", emoji: "🔴", label: "Срок годности истёк", daysRemaining };
  if (daysRemaining <= MEDICATION_EXPIRATION_THRESHOLDS.soonDays) return { id: "soon", emoji: "🟠", label: "Срок годности истекает в течение 30 дней", daysRemaining };
  if (daysRemaining <= MEDICATION_EXPIRATION_THRESHOLDS.mediumDays) return { id: "medium", emoji: "🟡", label: "Срок годности истекает через 31–90 дней", daysRemaining };
  if (daysRemaining <= MEDICATION_EXPIRATION_THRESHOLDS.comfortableDays) return { id: "fresh", emoji: "🟢", label: "До истечения срока годности 91–180 дней", daysRemaining };
  if (daysRemaining <= MEDICATION_EXPIRATION_THRESHOLDS.yearDays) return { id: "long", emoji: "🔵", label: "До истечения срока годности 181–365 дней", daysRemaining };
  return { id: "very-long", emoji: "🟣", label: "До истечения срока годности больше года", daysRemaining };
}

export function formatMedicationNameWithExpiration(medication, today) {
  const status = medicationExpirationStatus(medication?.expirationDate, today);
  return `${status.emoji} ${medication?.name || "Неизвестное лекарство"}`;
}

function remainingDaysLabel(days) {
  const mod100 = days % 100; const mod10 = days % 10;
  const word = mod100 >= 11 && mod100 <= 14 ? "дней" : mod10 === 1 ? "день" : mod10 >= 2 && mod10 <= 4 ? "дня" : "дней";
  return `${days} ${word}`;
}

export function formatMedicationExpirationRemaining(expirationDate, today) {
  const status = medicationExpirationStatus(expirationDate, today);
  if (status.id === "unknown") return null;
  if (status.daysRemaining < 0) return "Срок истёк";
  return `Осталось: ${remainingDaysLabel(status.daysRemaining)}`;
}

export function isValidScheduleTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeSchedule(values) {
  if (!Array.isArray(values) || !values.length) throw new Error("Добавьте хотя бы одно время приёма.");
  const schedule = values.map((value) => String(value || "").trim());
  if (schedule.some((value) => !isValidScheduleTime(value))) throw new Error("Время приёма должно быть указано в формате ЧЧ:ММ.");
  if (new Set(schedule).size !== schedule.length) throw new Error("Времена приёма не должны повторяться.");
  return schedule.sort();
}

export function dayPartForTime(time) {
  if (!isValidScheduleTime(time)) throw new Error("Некорректное время приёма.");
  const hour = Number(time.slice(0, 2));
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

export function validateMedicationCourse(course, medicationIds = null) {
  if (!course || typeof course !== "object") throw new Error("Некорректный курс лекарства.");
  if (!course.medicationId || (medicationIds && !medicationIds.has(course.medicationId))) throw new Error("Выберите лекарство из справочника.");
  const amount = parseMedicationAmount(course.amount);
  if (!UNIT_BY_ID[course.unitId]) throw new Error("Выберите единицу измерения.");
  if (!isValidDateOnly(course.startDate)) throw new Error("Укажите корректную дату начала курса.");
  if (course.endDate !== null && course.endDate !== "" && !isValidDateOnly(course.endDate)) throw new Error("Укажите корректную дату окончания курса.");
  const endDate = course.endDate || null;
  if (endDate && endDate < course.startDate) throw new Error("Дата окончания не может быть раньше даты начала.");
  const schedule = normalizeSchedule(course.schedule);
  if (!Object.hasOwn(FOOD_RELATIONS, course.foodRelation)) throw new Error("Выберите зависимость от еды.");
  if (typeof (course.comment ?? "") !== "string" || course.comment.length > 1000) throw new Error("Комментарий слишком длинный.");
  return { ...course, amount, endDate, schedule, comment: course.comment || "", archived: Boolean(course.archived) };
}

export function isCourseActiveOn(course, date) {
  return isValidDateOnly(date) && (!course.archived || Boolean(course.endDate)) && date >= course.startDate && (!course.endDate || date <= course.endDate);
}

export function isCourseCompletedOn(course, date) {
  return Boolean(course?.archived || (isValidDateOnly(date) && course?.endDate && course.endDate < date));
}

export function intakeKey(courseId, date, time) { return `${courseId}|${date}|${time}`; }

function medicationNamePriority(name) {
  const first = String(name || "").trim().charAt(0);
  if (/[A-Za-z]/.test(first)) return 0;
  if (/[А-Яа-яЁё]/.test(first)) return 1;
  return 2;
}

function compareMedicationNames(left, right) {
  const leftPriority = medicationNamePriority(left); const rightPriority = medicationNamePriority(right);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return (leftPriority === 0 ? LATIN_NAME_COLLATOR : CYRILLIC_NAME_COLLATOR).compare(left, right);
}

export function buildDaySchedule(courses, intakes, date, medications = []) {
  const intakeMap = new Map((intakes || []).map((item) => [intakeKey(item.courseId, item.scheduledDate, item.scheduledTime), item]));
  const medicationNames = new Map((medications || []).map((item) => [item.id, item.name]));
  const groups = Object.fromEntries(DAY_PARTS.map((part) => [part.id, []]));
  for (const course of courses || []) {
    if (!isCourseActiveOn(course, date)) continue;
    for (const time of course.schedule) {
      const history = intakeMap.get(intakeKey(course.id, date, time)) || null;
      groups[dayPartForTime(time)].push({ course, date, time, history });
    }
  }
  for (const values of Object.values(groups)) values.sort((a, b) => a.time.localeCompare(b.time)
    || (FOOD_RELATION_SORT_ORDER[a.course.foodRelation] ?? 99) - (FOOD_RELATION_SORT_ORDER[b.course.foodRelation] ?? 99)
    || compareMedicationNames(medicationNames.get(a.course.medicationId) || a.course.medicationId, medicationNames.get(b.course.medicationId) || b.course.medicationId)
    || a.course.id.localeCompare(b.course.id));
  return groups;
}

export function plannedIntakeCount(courses, startDate, endDate) {
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate) || startDate > endDate) return 0;
  let count = 0;
  const cursor = new Date(`${startDate}T12:00:00Z`); const end = new Date(`${endDate}T12:00:00Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    count += (courses || []).filter((course) => isCourseActiveOn(course, date)).reduce((sum, course) => sum + course.schedule.length, 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

export function medicationStatistics(courses, intakes, startDate, endDate) {
  const relevant = (intakes || []).filter((item) => item.scheduledDate >= startDate && item.scheduledDate <= endDate);
  const planned = plannedIntakeCount(courses, startDate, endDate);
  const taken = relevant.filter((item) => item.status === "taken");
  const skipped = relevant.filter((item) => item.status === "skipped").length;
  const doses = taken.length;
  const byMedication = new Map();
  for (const item of relevant) {
    const course = courses.find((value) => value.id === item.courseId);
    const key = course?.medicationId || "unknown";
    const stats = byMedication.get(key) || { taken: 0, skipped: 0 };
    stats[item.status] = (stats[item.status] || 0) + 1; byMedication.set(key, stats);
  }
  const activeCourses = (courses || []).filter((course) => !course.archived && course.startDate <= endDate && (!course.endDate || course.endDate >= endDate)).length;
  const completedCourses = (courses || []).filter((course) => course.archived || Boolean(course.endDate && course.endDate < endDate)).length;
  return { planned, taken: taken.length, skipped, adherence: planned ? Math.round((taken.length / planned) * 100) : 0, doses, activeCourses, completedCourses, byMedication };
}

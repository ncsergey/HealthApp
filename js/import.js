import { isFuture } from "./datetime.js";
import { DEFAULT_BODY_PARTS, MEDICATION_AMOUNT_MAX, MEDICATION_AMOUNT_MIN, UNIT_BY_ID, normalizeDirectoryName, normalizedNameKey, stableNameId } from "./pain.js";
import { FOOD_RELATIONS, isValidDateOnly, isValidScheduleTime, validateMedicationCourse } from "./medications.js";
import { isValidGlassTransparency, isValidInterface } from "./interface-settings.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_TEXT_LENGTH = 100_000;
const GLUCOSE_FORMATS = new Set(["plasma", "wholeBlood"]);
const GLUCOSE_CONTEXTS = new Set(["fasting", "beforeMeal", "after1h", "after2h", "random"]);
const PULSE_CONTEXTS = new Set(["resting", "active", "unknown"]);

function validIso(value) { return typeof value === "string" && value.length <= 40 && !Number.isNaN(new Date(value).getTime()); }
function validDateOnly(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const [year, month, day] = value.split("-").map(Number); const date = new Date(Date.UTC(year, month - 1, day)); return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day && value <= new Date().toISOString().slice(0, 10); }
function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 200; }
function validText(value) { return typeof value === "string" && value.length <= MAX_TEXT_LENGTH; }
function integerInRange(value, min, max) { return Number.isInteger(value) && Number.isFinite(value) && value >= min && value <= max; }

function validateCommon(record, index, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Некорректная запись ${label} №${index + 1}.`);
  if (!validId(record.id) || !validIso(record.measuredAt) || !validIso(record.editedAt)) throw new Error(`Некорректные ID или даты в записи ${label} №${index + 1}.`);
  if (isFuture(record.measuredAt)) throw new Error(`Дата и время измерения в будущем в записи ${label} №${index + 1}.`);
}

function validatePressure(record, index) { validateCommon(record, index, "давления"); if (!integerInRange(record.systolic, 30, 300) || !integerInRange(record.diastolic, 10, 180)) throw new Error(`Числовые значения вне допустимого диапазона в записи давления №${index + 1}.`); if (!validText(record.comment)) throw new Error(`Некорректный комментарий в записи давления №${index + 1}.`); return { id: record.id, measuredAt: new Date(record.measuredAt).toISOString(), editedAt: new Date(record.editedAt).toISOString(), systolic: record.systolic, diastolic: record.diastolic, comment: record.comment }; }
function validatePulse(record, index, allowMissingContext = false) { validateCommon(record, index, "пульса"); if (!integerInRange(record.pulse, 20, 400)) throw new Error(`Значение пульса вне допустимого диапазона в записи №${index + 1}.`); const context = record.context || (allowMissingContext ? "unknown" : ""); if (!PULSE_CONTEXTS.has(context)) throw new Error(`Некорректный контекст в записи пульса №${index + 1}.`); const spo2 = record.spo2 === null || record.spo2 === undefined ? null : record.spo2; const stress = record.stress === null || record.stress === undefined ? null : record.stress; if (spo2 !== null && !integerInRange(spo2, 1, 100)) throw new Error(`SpO2 должен быть целым числом от 1 до 100% в записи пульса №${index + 1}.`); if (stress !== null && !integerInRange(stress, 0, 100)) throw new Error(`Стресс должен быть целым числом от 0 до 100% в записи пульса №${index + 1}.`); if (!validText(record.comment)) throw new Error(`Некорректный комментарий в записи пульса №${index + 1}.`); return { id: record.id, measuredAt: new Date(record.measuredAt).toISOString(), editedAt: new Date(record.editedAt).toISOString(), pulse: record.pulse, context, spo2, stress, comment: record.comment }; }
function validateGlucose(record, index) { validateCommon(record, index, "глюкозы"); if (!Number.isFinite(record.value) || record.value < 1 || record.value > 40 || !Number.isInteger(record.value * 10)) throw new Error(`Значение глюкозы вне диапазона 1,0–40,0 в записи №${index + 1}.`); if (!GLUCOSE_FORMATS.has(record.format) || !GLUCOSE_CONTEXTS.has(record.context)) throw new Error(`Некорректный формат или контекст глюкозы в записи №${index + 1}.`); if (!validText(record.comment)) throw new Error(`Некорректный комментарий в записи глюкозы №${index + 1}.`); return { id: record.id, measuredAt: new Date(record.measuredAt).toISOString(), editedAt: new Date(record.editedAt).toISOString(), value: record.value, format: record.format, context: record.context, comment: record.comment }; }
function validateWeight(record, index) { validateCommon(record, index, "веса"); if (!integerInRange(record.weight, 1, 700)) throw new Error(`Вес вне диапазона 1–700 кг в записи №${index + 1}.`); if (!validText(record.comment)) throw new Error(`Некорректный комментарий в записи веса №${index + 1}.`); return { id: record.id, measuredAt: new Date(record.measuredAt).toISOString(), editedAt: new Date(record.editedAt).toISOString(), weight: record.weight, comment: record.comment }; }

function validateProfile(profile) {
  if (profile === null) return null;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Некорректный профиль.");
  if (!validDateOnly(profile.birthDate)) throw new Error("Некорректная дата рождения в профиле.");
  if (profile.sex !== "male" && profile.sex !== "female") throw new Error("Некорректный пол в профиле.");
  if (!integerInRange(profile.heightCm, 50, 300)) throw new Error("Рост в профиле должен быть от 50 до 300 см.");
  if (!validIso(profile.editedAt)) throw new Error("Некорректная дата редактирования профиля.");
  return { id: "profile", birthDate: profile.birthDate, sex: profile.sex, heightCm: profile.heightCm, editedAt: new Date(profile.editedAt).toISOString() };
}

function validateDirectory(items, label) {
  const ids = new Set(); const names = new Set();
  return items.map((item, index) => {
    if (!item || !validId(item.id) || !validIso(item.editedAt)) throw new Error(`Некорректный элемент справочника «${label}» №${index + 1}.`);
    const name = normalizeDirectoryName(item.name); const nameKey = normalizedNameKey(name);
    if (!name || name.length > 100 || ids.has(item.id) || names.has(nameKey)) throw new Error(`Пустое или повторяющееся значение в справочнике «${label}».`);
    ids.add(item.id); names.add(nameKey); return { id: item.id, name, nameKey, editedAt: new Date(item.editedAt).toISOString() };
  });
}

function legacyPain(record, index, version, medicationMap) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Некорректный эпизод боли №${index + 1}.`);
  if (!validId(record.id) || !validIso(record.startedAt) || !validIso(record.editedAt)) throw new Error(`Некорректные ID или даты в эпизоде №${index + 1}.`);
  const intensityMin = version >= 5 ? record.intensityMin : record.intensity; const intensityMax = version >= 5 ? record.intensityMax : record.intensity;
  const medicationName = normalizeDirectoryName(record.medication); const medicationId = medicationName ? stableNameId("med", medicationName) : null;
  if (medicationId && !medicationMap.has(normalizedNameKey(medicationName))) medicationMap.set(normalizedNameKey(medicationName), { id: medicationId, name: medicationName, nameKey: normalizedNameKey(medicationName), editedAt: new Date(record.editedAt).toISOString() });
  return validatePain({ ...record, bodyPartId: "body-head", intensityMin, intensityMax, medicationId, medicationAmount: null, medicationUnitId: null, medicationTakenAt: version >= 5 ? record.medicationTakenAt : null }, index, new Set(DEFAULT_BODY_PARTS.map((item) => item.id)), new Set([...medicationMap.values()].map((item) => item.id)), true);
}

function validatePain(record, index, bodyPartIds, medicationIds, allowLegacyMedicationTime = false) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Некорректный эпизод боли №${index + 1}.`);
  if (!validId(record.id) || !validId(record.bodyPartId) || !bodyPartIds.has(record.bodyPartId) || !validIso(record.startedAt) || !validIso(record.editedAt)) throw new Error(`Некорректные ID или даты в эпизоде боли №${index + 1}.`);
  if (record.endedAt !== null && !validIso(record.endedAt)) throw new Error(`Некорректное время окончания в эпизоде №${index + 1}.`);
  if (!integerInRange(record.intensityMin, 1, 10) || !integerInRange(record.intensityMax, 1, 10) || record.intensityMin > record.intensityMax) throw new Error(`Интенсивность вне диапазона 1–10 или min выше max в эпизоде №${index + 1}.`);
  if (!validText(record.comment)) throw new Error(`Некорректный комментарий в эпизоде №${index + 1}.`);
  const startedAt = new Date(record.startedAt).toISOString(); const endedAt = record.endedAt === null ? null : new Date(record.endedAt).toISOString();
  const medicationId = record.medicationId || null; const medicationAmount = record.medicationAmount ?? null; const medicationUnitId = record.medicationUnitId || null; const medicationTakenAt = record.medicationTakenAt || null;
  if (medicationId && !medicationIds.has(medicationId)) throw new Error(`Неизвестное лекарство в эпизоде №${index + 1}.`);
  if (!medicationId && (medicationAmount !== null || medicationUnitId || medicationTakenAt)) throw new Error(`Данные приёма указаны без лекарства в эпизоде №${index + 1}.`);
  const hasDose = medicationAmount !== null || medicationUnitId !== null;
  if (medicationId && hasDose && !allowLegacyMedicationTime && (!Number.isFinite(medicationAmount) || medicationAmount < MEDICATION_AMOUNT_MIN || medicationAmount > MEDICATION_AMOUNT_MAX || !Number.isInteger(medicationAmount * 10) || !UNIT_BY_ID[medicationUnitId])) throw new Error(`Укажите корректные количество и единицу лекарства в эпизоде №${index + 1}.`);
  if ((medicationAmount === null) !== (medicationUnitId === null)) throw new Error(`Количество и единица лекарства должны быть заполнены вместе в эпизоде №${index + 1}.`);
  if (medicationTakenAt && !validIso(medicationTakenAt)) throw new Error(`Некорректное время приёма лекарства в эпизоде №${index + 1}.`);
  if (isFuture(startedAt) || (endedAt && isFuture(endedAt)) || (medicationTakenAt && isFuture(medicationTakenAt))) throw new Error(`Дата в будущем в эпизоде №${index + 1}.`);
  if (endedAt && new Date(endedAt) < new Date(startedAt)) throw new Error(`Окончание раньше начала в эпизоде №${index + 1}.`);
  if (medicationTakenAt && new Date(medicationTakenAt) < new Date(startedAt)) throw new Error(`Приём лекарства раньше начала приступа в эпизоде №${index + 1}.`);
  return { id: record.id, bodyPartId: record.bodyPartId, startedAt, endedAt, intensityMin: record.intensityMin, intensityMax: record.intensityMax,
    medicationId, medicationAmount, medicationUnitId, medicationTakenAt: medicationTakenAt ? new Date(medicationTakenAt).toISOString() : null,
    comment: record.comment, editedAt: new Date(record.editedAt).toISOString() };
}

function assertUniqueIds(items, label) { const ids = new Set(); for (const item of items) { if (ids.has(item.id)) throw new Error(`В файле повторяется ID записи (${label}).`); ids.add(item.id); } }

function validateMedicationCourseRecord(record, index, medicationIds) {
  if (!record || !validId(record.id) || !validIso(record.editedAt)) throw new Error(`Некорректный курс лекарства №${index + 1}.`);
  try {
    const course = validateMedicationCourse(record, medicationIds);
    return { id: record.id, medicationId: course.medicationId, amount: course.amount, unitId: course.unitId, startDate: course.startDate,
      endDate: course.endDate, schedule: course.schedule, foodRelation: course.foodRelation, comment: course.comment, archived: course.archived,
      editedAt: new Date(record.editedAt).toISOString() };
  } catch (error) { throw new Error(`Курс лекарства №${index + 1}: ${error.message}`); }
}

function validateMedicationIntake(record, index, courseIds) {
  if (!record || !validId(record.id) || !validIso(record.editedAt) || !courseIds.has(record.courseId)) throw new Error(`Некорректная запись приёма лекарства №${index + 1}.`);
  if (!isValidDateOnly(record.scheduledDate) || !isValidScheduleTime(record.scheduledTime)) throw new Error(`Некорректные запланированные дата или время приёма №${index + 1}.`);
  if (!["planned", "taken", "skipped"].includes(record.status)) throw new Error(`Некорректный статус приёма №${index + 1}.`);
  const actualTakenAt = record.actualTakenAt || null;
  if (actualTakenAt && (!validIso(actualTakenAt) || isFuture(actualTakenAt))) throw new Error(`Некорректкое фактическое время приёма №${index + 1}.`);
  if (record.status === "taken" && !actualTakenAt) throw new Error(`Для принятого лекарства не указано фактическое время №${index + 1}.`);
  if (!Number.isFinite(record.amount) || record.amount < MEDICATION_AMOUNT_MIN || record.amount > MEDICATION_AMOUNT_MAX || !Number.isInteger(record.amount * 10) || !UNIT_BY_ID[record.unitId]) throw new Error(`Некорректная дозировка приёма №${index + 1}.`);
  if (!Object.hasOwn(FOOD_RELATIONS, record.foodRelation) || !validText(record.comment || "")) throw new Error(`Некорректные дополнительные данные приёма №${index + 1}.`);
  return { id: record.id, courseId: record.courseId, scheduledDate: record.scheduledDate, scheduledTime: record.scheduledTime,
    actualTakenAt: actualTakenAt ? new Date(actualTakenAt).toISOString() : null, status: record.status, amount: record.amount,
    unitId: record.unitId, foodRelation: record.foodRelation, comment: record.comment || "", editedAt: new Date(record.editedAt).toISOString() };
}

export async function parseBackupFile(file) {
  if (!file) throw new Error("Файл не выбран."); if (file.size > MAX_FILE_SIZE) throw new Error("Файл слишком большой (максимум 20 МБ).");
  let raw; try { raw = JSON.parse(await file.text()); } catch { throw new Error("Не удалось прочитать JSON-файл."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Некорректная структура резервной копии.");
  if (raw.format !== "health-diary-backup" || ![1, 2, 3, 4, 5, 6, 7, 8].includes(raw.version)) throw new Error("Неподдерживаемый формат или версия резервной копии.");
  if (raw.version === 8 && (typeof raw.exportedAt !== "string" || !Number.isFinite(Date.parse(raw.exportedAt)))) throw new Error("Некорректная дата экспорта резервной копии.");
  if (raw.version === 8 && (!raw.settings || typeof raw.settings !== "object" || Array.isArray(raw.settings) || !isValidInterface(raw.settings.interface) || !isValidGlassTransparency(raw.settings.glassTransparency))) throw new Error("Некорректные настройки интерфейса в резервной копии.");
  const painSource = raw.version >= 6 ? raw.painEpisodes : raw.headacheEpisodes;
  if (!Array.isArray(raw.pressureMeasurements) || !Array.isArray(painSource)) throw new Error("В резервной копии отсутствуют необходимые массивы.");
  if (raw.version >= 2 && (!Array.isArray(raw.glucoseMeasurements) || !Array.isArray(raw.weightMeasurements))) throw new Error(`В резервной копии версии ${raw.version} отсутствуют необходимые массивы.`);
  if (raw.version >= 3 && !Array.isArray(raw.pulseMeasurements)) throw new Error(`В резервной копии версии ${raw.version} отсутствует массив пульса.`);
  if (raw.version >= 6 && (!Array.isArray(raw.bodyParts) || !Array.isArray(raw.medications))) throw new Error(`В резервной копии версии ${raw.version} отсутствуют справочники.`);
  if (raw.version >= 7 && (!Array.isArray(raw.medicationCourses) || !Array.isArray(raw.medicationIntakes))) throw new Error(`В резервной копии версии ${raw.version} отсутствуют курсы или история приёмов.`);
  const legacyPressure = raw.version < 3 ? raw.pressureMeasurements.map((record, index) => { if (!integerInRange(record?.pulse, 20, 400)) throw new Error(`Числовые значения вне допустимого диапазона в записи давления №${index + 1}.`); const pressure = validatePressure(record, index); const pulse = validatePulse({ id: pressure.id, measuredAt: pressure.measuredAt, editedAt: pressure.editedAt, pulse: record.pulse, context: "unknown", comment: pressure.comment }, index); return { pressure, pulse }; }) : null;
  const medicationMap = new Map();
  const bodyParts = raw.version >= 6 ? validateDirectory(raw.bodyParts, "Части тела") : DEFAULT_BODY_PARTS.map((item) => ({ ...item, nameKey: normalizedNameKey(item.name), editedAt: new Date(0).toISOString() }));
  let medications = raw.version >= 6 ? validateDirectory(raw.medications, "Лекарства") : [];
  for (const item of medications) medicationMap.set(item.nameKey, item);
  const bodyPartIds = new Set(bodyParts.map((item) => item.id)); const medicationIds = new Set(medications.map((item) => item.id));
  const painEpisodes = raw.version >= 6 ? painSource.map((record, index) => validatePain(record, index, bodyPartIds, medicationIds)) : painSource.map((record, index) => legacyPain(record, index, raw.version, medicationMap));
  if (raw.version < 6) medications = [...medicationMap.values()];
  const medicationCourses = raw.version >= 7 ? raw.medicationCourses.map((record, index) => validateMedicationCourseRecord(record, index, medicationIds)) : [];
  const courseIds = new Set(medicationCourses.map((item) => item.id));
  const medicationIntakes = raw.version >= 7 ? raw.medicationIntakes.map((record, index) => validateMedicationIntake(record, index, courseIds)) : [];
  const data = { profile: raw.version >= 2 ? validateProfile(raw.profile ?? null) : null,
    pressureMeasurements: legacyPressure ? legacyPressure.map((item) => item.pressure) : raw.pressureMeasurements.map(validatePressure),
    pulseMeasurements: legacyPressure ? legacyPressure.map((item) => item.pulse) : raw.pulseMeasurements.map((record, index) => validatePulse(record, index, raw.version === 3)),
    painEpisodes, glucoseMeasurements: raw.version >= 2 ? raw.glucoseMeasurements.map(validateGlucose) : [], weightMeasurements: raw.version >= 2 ? raw.weightMeasurements.map(validateWeight) : [], bodyParts, medications, medicationCourses, medicationIntakes,
    uiSettings: raw.version === 8 ? { interface: raw.settings.interface, glassTransparency: raw.settings.glassTransparency } : null };
  for (const [key, label] of [["pressureMeasurements", "давление"], ["pulseMeasurements", "пульс"], ["painEpisodes", "боль"], ["glucoseMeasurements", "глюкоза"], ["weightMeasurements", "вес"], ["medicationCourses", "курсы"], ["medicationIntakes", "приёмы"]]) assertUniqueIds(data[key], label);
  data.headacheEpisodes = data.painEpisodes;
  return data;
}

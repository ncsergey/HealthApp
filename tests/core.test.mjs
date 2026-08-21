import assert from "node:assert/strict";
import test from "node:test";

import { isFuture, moscowDateTimeInputToIso, moscowInputToIso } from "../js/datetime.js";
import { parseBackupFile } from "../js/import.js";
import { ageOnDate, calculateBmi, evaluateBmi, evaluateGlucose, evaluatePressure, evaluatePulse, isBirthdayOnDate } from "../js/medical.js";
import { formatMedicationDose, hasOngoingPainForBodyPart, normalizedNameKey, parseMedicationAmount } from "../js/pain.js";
import { filterDataForPeriod, glucoseStats, headacheStats, overviewStats, pressureStats, pulseStats, weightStats } from "../js/statistics.js";
import { buildDaySchedule, dayPartForTime, isCourseCompletedOn, medicationStatistics, normalizeSchedule, validateMedicationCourse } from "../js/medications.js";
import { createBackupPayload } from "../js/export.js";
import { DEFAULT_GLASS_TRANSPARENCY, UI_SETTINGS_KEY, initializeUiSettings, readUiSettings, saveUiSettings } from "../js/interface-settings.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

function backupFile(payload) {
  const text = JSON.stringify(payload);
  return { size: text.length, text: async () => text };
}

const emptyBackupData = Object.freeze({
  profile: null, pressureMeasurements: [], pulseMeasurements: [], painEpisodes: [], glucoseMeasurements: [], weightMeasurements: [],
  bodyParts: [], medications: [], medicationCourses: [], medicationIntakes: []
});

test("московское время сохраняется в UTC", () => {
  assert.equal(moscowInputToIso("2026-08-10", "08:30"), "2026-08-10T05:30:00.000Z");
  assert.throws(() => moscowInputToIso("2026-02-30", "08:30"));
  assert.equal(moscowDateTimeInputToIso("2026-08-10T08:30"), "2026-08-10T05:30:00.000Z");
  assert.throws(() => moscowDateTimeInputToIso("2026-02-30T08:30"));
});

test("единица «штука» форматируется как «шт.»", () => {
  assert.equal(formatMedicationDose(2, "piece"), "2 шт.");
});

test("будущее время определяется относительно переданного момента", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  assert.equal(isFuture("2026-08-11T12:00:00.000Z", now), false);
  assert.equal(isFuture("2026-08-11T12:00:00.001Z", now), true);
});

test("возраст и день рождения определяются на выбранную дату", () => {
  assert.equal(ageOnDate("1990-08-21", new Date("2026-08-21T12:00:00.000Z")), 36);
  assert.equal(ageOnDate("1990-08-22", new Date("2026-08-21T12:00:00.000Z")), 35);
  assert.equal(isBirthdayOnDate("1990-08-21", "2026-08-21"), true);
  assert.equal(isBirthdayOnDate("1990-08-22", "2026-08-21"), false);
});

test("статистика давления рассчитывается из исходных записей", () => {
  const result = pressureStats([
    { systolic: 120, diastolic: 80 },
    { systolic: 140, diastolic: 90 }
  ]);
  assert.deepEqual(result, {
    count: 2,
    avgSystolic: 130,
    avgDiastolic: 85,
    minSystolic: 120,
    maxSystolic: 140,
    minDiastolic: 80,
    maxDiastolic: 90
  });
});

test("статистика пульса рассчитывается отдельно от давления", () => {
  assert.deepEqual(pulseStats([{ pulse: 60 }, { pulse: 70 }]), { count: 2, average: 65, min: 60, max: 70 });
});

test("обзор различает давление внутри и вне эпизода", () => {
  const data = {
    pressureMeasurements: [
      { measuredAt: "2026-08-10T08:00:00.000Z", systolic: 140, diastolic: 90, pulse: 70 },
      { measuredAt: "2026-08-10T12:00:00.000Z", systolic: 120, diastolic: 80, pulse: 60 }
    ],
    headacheEpisodes: [{ startedAt: "2026-08-10T07:00:00.000Z", endedAt: "2026-08-10T09:00:00.000Z", intensity: 5 }]
  };
  const result = overviewStats(data, { start: new Date("2026-08-10T00:00:00.000Z"), end: new Date("2026-08-10T23:59:59.999Z") });
  assert.equal(result.during.count, 1);
  assert.equal(result.during.avgSystolic, 140);
  assert.equal(result.outside.avgSystolic, 120);
});

test("незавершённые эпизоды не входят в среднюю длительность", () => {
  const result = headacheStats([
    { startedAt: "2026-08-10T08:00:00.000Z", endedAt: "2026-08-10T10:00:00.000Z", intensityMin: 2, intensityMax: 4, medication: "", comment: "" },
    { startedAt: "2026-08-10T11:00:00.000Z", endedAt: null, intensityMin: 6, intensityMax: 8, medication: "Ибупрофен", comment: "" }
  ], new Date("2026-08-10T12:00:00.000Z"));
  assert.equal(result.averageDuration, 7_200_000);
  assert.equal(result.completedCount, 1);
  assert.equal(result.ongoingCount, 1);
  assert.equal(result.averageIntensityMin, 4);
  assert.equal(result.averageIntensityMax, 6);
  assert.equal(result.minIntensity, 2);
  assert.equal(result.maxIntensity, 8);
});

test("импорт полностью проверяется до возврата данных", async () => {
  const valid = {
    format: "health-diary-backup",
    version: 4,
    exportedAt: "2026-08-10T06:00:00.000Z",
    profile: null,
    pressureMeasurements: [{ id: "p1", measuredAt: "2026-08-10T05:30:00.000Z", editedAt: "2026-08-10T05:31:00.000Z", systolic: 120, diastolic: 80, comment: "" }],
    pulseMeasurements: [{ id: "u1", measuredAt: "2026-08-10T05:30:00.000Z", editedAt: "2026-08-10T05:31:00.000Z", pulse: 60, context: "resting", comment: "" }],
    headacheEpisodes: [], glucoseMeasurements: [], weightMeasurements: []
  };
  const parsed = await parseBackupFile({ size: 100, text: async () => JSON.stringify(valid) });
  assert.equal(parsed.pressureMeasurements.length, 1);
  assert.equal(parsed.pulseMeasurements.length, 1);
  assert.equal(parsed.pressureMeasurements[0].pulse, undefined);

  const invalid = structuredClone(valid);
  invalid.pressureMeasurements[0].systolic = -1;
  await assert.rejects(() => parseBackupFile({ size: 100, text: async () => JSON.stringify(invalid) }), /допустимого диапазона/);
});

test("импорт принимает границы диапазонов давления и пульса", async () => {
  const backup = {
    format: "health-diary-backup",
    version: 4,
    exportedAt: "2026-08-10T07:00:00.000Z",
    profile: null,
    pressureMeasurements: [
      { id: "min", measuredAt: "2026-08-10T05:30:00.000Z", editedAt: "2026-08-10T05:31:00.000Z", systolic: 30, diastolic: 10, comment: "" },
      { id: "max", measuredAt: "2026-08-10T06:30:00.000Z", editedAt: "2026-08-10T06:31:00.000Z", systolic: 300, diastolic: 180, comment: "" }
    ],
    pulseMeasurements: [
      { id: "pulse-min", measuredAt: "2026-08-10T05:30:00.000Z", editedAt: "2026-08-10T05:31:00.000Z", pulse: 20, context: "resting", comment: "" },
      { id: "pulse-max", measuredAt: "2026-08-10T06:30:00.000Z", editedAt: "2026-08-10T06:31:00.000Z", pulse: 400, context: "active", comment: "" }
    ],
    headacheEpisodes: [], glucoseMeasurements: [], weightMeasurements: []
  };

  const parsed = await parseBackupFile({ size: 100, text: async () => JSON.stringify(backup) });
  assert.equal(parsed.pressureMeasurements.length, 2);
  assert.equal(parsed.pulseMeasurements.length, 2);
});

test("импорт отклоняет будущие даты и окончание раньше начала", async () => {
  const backup = {
    format: "health-diary-backup",
    version: 4,
    exportedAt: "2026-08-10T08:00:00.000Z",
    profile: null,
    pressureMeasurements: [{ id: "p1", measuredAt: "2026-08-10T05:30:00.000Z", editedAt: "2026-08-10T05:31:00.000Z", systolic: 120, diastolic: 80, comment: "" }],
    pulseMeasurements: [{ id: "u1", measuredAt: "2026-08-10T05:30:00.000Z", editedAt: "2026-08-10T05:31:00.000Z", pulse: 60, context: "resting", comment: "" }],
    headacheEpisodes: [{ id: "h1", startedAt: "2026-08-10T06:00:00.000Z", endedAt: "2026-08-10T07:00:00.000Z", editedAt: "2026-08-10T07:01:00.000Z", intensity: 5, medication: "", comment: "" }],
    glucoseMeasurements: [], weightMeasurements: []
  };

  const futurePressure = structuredClone(backup);
  futurePressure.pressureMeasurements[0].measuredAt = "2999-01-01T00:00:00.000Z";
  await assert.rejects(() => parseBackupFile({ size: 100, text: async () => JSON.stringify(futurePressure) }), /будущем/);

  const futureStart = structuredClone(backup);
  futureStart.headacheEpisodes[0].startedAt = "2999-01-01T00:00:00.000Z";
  futureStart.headacheEpisodes[0].endedAt = null;
  await assert.rejects(() => parseBackupFile({ size: 100, text: async () => JSON.stringify(futureStart) }), /будущем/);

  const futureEnd = structuredClone(backup);
  futureEnd.headacheEpisodes[0].endedAt = "2999-01-01T00:00:00.000Z";
  await assert.rejects(() => parseBackupFile({ size: 100, text: async () => JSON.stringify(futureEnd) }), /будущем/);

  const reversed = structuredClone(backup);
  reversed.headacheEpisodes[0].endedAt = "2026-08-10T05:59:00.000Z";
  await assert.rejects(() => parseBackupFile({ size: 100, text: async () => JSON.stringify(reversed) }), /раньше начала/);
});

test("ИМТ рассчитывается при отображении и не получает взрослый статус у ребёнка", () => {
  assert.equal(calculateBmi(81, 180), 25);
  assert.equal(evaluateBmi({ bmi: 24.9, age: 30 }).level, "normal");
  assert.equal(evaluateBmi({ bmi: 15.9, age: 30 }).level, "critical");
  assert.equal(evaluateBmi({ bmi: 22, age: 17 }).level, "insufficient");
});

test("критическое давление имеет приоритет, а пульс без контекста покоя не оценивается", () => {
  const pressure = evaluatePressure(181, 80);
  assert.equal(pressure.level, "critical");
  assert.equal(pressure.systolic.level, "critical");
  assert.equal(pressure.diastolic.level, "normal");
  assert.equal(evaluatePulse(70, { age: 40, restingKnown: false }).level, "insufficient");
  assert.equal(evaluatePulse(70, { age: 40, restingKnown: true, contextKnown: true }).level, "normal");
  assert.match(evaluatePulse(70, { age: 40, restingKnown: false, contextKnown: true }).missingReason, /вне покоя/);
});

test("глюкоза оценивается только для поддержанного формата и применимого контекста", () => {
  assert.equal(evaluateGlucose({ value: 5.5, format: "plasma", context: "fasting", age: 35 }).level, "normal");
  assert.equal(evaluateGlucose({ value: 5.6, format: "plasma", context: "fasting", age: 35 }).level, "high");
  assert.equal(evaluateGlucose({ value: 5.5, format: "wholeBlood", context: "fasting", age: 35 }).level, "insufficient");
  assert.equal(evaluateGlucose({ value: 5.5, format: "plasma", context: "random", age: 35 }).level, "insufficient");
});

test("статистика веса использует даты измерений, а не даты редактирования", () => {
  const stats = weightStats([
    { measuredAt: "2026-08-10T08:00:00.000Z", editedAt: "2026-08-14T12:00:00.000Z", weight: 100 },
    { measuredAt: "2026-08-14T08:00:00.000Z", editedAt: "2026-08-14T08:01:00.000Z", weight: 81 }
  ]);
  assert.equal(stats.current.weight, 81);
  assert.equal(stats.change, -19);
});

test("фильтрация периода включает пульс, глюкозу и вес", () => {
  const data = { profile: null, pressureMeasurements: [], pulseMeasurements: [{ measuredAt: "2026-08-10T09:00:00Z" }], headacheEpisodes: [], glucoseMeasurements: [{ measuredAt: "2026-08-10T08:00:00Z" }], weightMeasurements: [{ measuredAt: "2026-08-11T08:00:00Z" }] };
  const filtered = filterDataForPeriod(data, { start: new Date("2026-08-10T00:00:00Z"), end: new Date("2026-08-10T23:59:59Z") });
  assert.equal(filtered.pulseMeasurements.length, 1);
  assert.equal(filtered.glucoseMeasurements.length, 1);
  assert.equal(filtered.weightMeasurements.length, 0);
});

test("импорт поддерживает резервные копии версий 1–3", async () => {
  const legacyPressure = { id: "p1", measuredAt: "2026-08-10T05:30:00Z", editedAt: "2026-08-10T05:31:00Z", systolic: 120, diastolic: 80, pulse: 64, comment: "" };
  const legacyHeadache = { id: "h1", startedAt: "2026-08-10T04:00:00Z", endedAt: "2026-08-10T05:00:00Z", editedAt: "2026-08-10T05:01:00Z", intensity: 6, medication: "", comment: "" };
  const version1 = { format: "health-diary-backup", version: 1, pressureMeasurements: [legacyPressure], headacheEpisodes: [legacyHeadache] };
  const parsed1 = await parseBackupFile({ size: 1000, text: async () => JSON.stringify(version1) });
  assert.equal(parsed1.pressureMeasurements.length, 1);
  assert.equal(parsed1.pulseMeasurements[0].pulse, 64);
  assert.equal(parsed1.pulseMeasurements[0].context, "unknown");
  assert.equal(parsed1.headacheEpisodes[0].intensityMin, 6);
  assert.equal(parsed1.headacheEpisodes[0].intensityMax, 6);
  assert.equal(parsed1.headacheEpisodes[0].medicationTakenAt, null);

  const version2 = { ...version1, version: 2, profile: null, glucoseMeasurements: [], weightMeasurements: [] };
  const parsed2 = await parseBackupFile({ size: 1000, text: async () => JSON.stringify(version2) });
  assert.equal(parsed2.pressureMeasurements.length, 1);
  assert.equal(parsed2.pulseMeasurements.length, 1);

  const version3 = {
    format: "health-diary-backup", version: 3, profile: null,
    pressureMeasurements: [{ id: "p3", measuredAt: "2026-08-10T05:30:00Z", editedAt: "2026-08-10T05:31:00Z", systolic: 120, diastolic: 80, comment: "" }],
    pulseMeasurements: [{ id: "u3", measuredAt: "2026-08-10T05:35:00Z", editedAt: "2026-08-10T05:36:00Z", pulse: 70, comment: "" }],
    headacheEpisodes: [], glucoseMeasurements: [], weightMeasurements: []
  };
  const parsed3 = await parseBackupFile({ size: 1000, text: async () => JSON.stringify(version3) });
  assert.equal(parsed3.pulseMeasurements[0].context, "unknown");
});

test("backup версии 4 проверяет контекст пульса", async () => {
  const backup = {
    format: "health-diary-backup", version: 4, exportedAt: "2026-08-10T06:00:00Z", profile: null,
    pressureMeasurements: [],
    pulseMeasurements: [{ id: "u1", measuredAt: "2026-08-10T05:35:00Z", editedAt: "2026-08-10T05:36:00Z", pulse: 70, context: "resting", spo2: 98, stress: 35, comment: "" }],
    headacheEpisodes: [], glucoseMeasurements: [], weightMeasurements: []
  };
  const parsed = await parseBackupFile({ size: 1000, text: async () => JSON.stringify(backup) });
  assert.equal(parsed.pulseMeasurements[0].context, "resting");
  assert.equal(parsed.pulseMeasurements[0].spo2, 98);
  assert.equal(parsed.pulseMeasurements[0].stress, 35);

  const invalid = structuredClone(backup); delete invalid.pulseMeasurements[0].context;
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(invalid) }), /контекст/);
  const invalidSpo2 = structuredClone(backup); invalidSpo2.pulseMeasurements[0].spo2 = 101;
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(invalidSpo2) }), /SpO2/);
  const invalidStress = structuredClone(backup); invalidStress.pulseMeasurements[0].stress = -1;
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(invalidStress) }), /Стресс/);
});

test("backup версии 5 проверяет диапазон интенсивности и время лекарства", async () => {
  const backup = {
    format: "health-diary-backup", version: 5, exportedAt: "2026-08-10T08:00:00Z", profile: null,
    pressureMeasurements: [], pulseMeasurements: [],
    headacheEpisodes: [{ id: "h5", startedAt: "2026-08-10T05:00:00Z", endedAt: "2026-08-10T07:00:00Z", editedAt: "2026-08-10T07:01:00Z", intensityMin: 3, intensityMax: 8, medication: "Ибупрофен", medicationTakenAt: "2026-08-10T05:30:00Z", comment: "" }],
    glucoseMeasurements: [], weightMeasurements: []
  };
  const parsed = await parseBackupFile({ size: 1000, text: async () => JSON.stringify(backup) });
  assert.equal(parsed.headacheEpisodes[0].intensityMin, 3);
  assert.equal(parsed.headacheEpisodes[0].intensityMax, 8);
  assert.equal(parsed.headacheEpisodes[0].medicationTakenAt, "2026-08-10T05:30:00.000Z");

  const reversedIntensity = structuredClone(backup); reversedIntensity.headacheEpisodes[0].intensityMin = 9;
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(reversedIntensity) }), /min выше max/);
  const earlyMedication = structuredClone(backup); earlyMedication.headacheEpisodes[0].medicationTakenAt = "2026-08-10T04:59:00Z";
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(earlyMedication) }), /раньше начала/);
});

test("backup версии 4 проверяет профиль, глюкозу и вес", async () => {
  const backup = {
    format: "health-diary-backup", version: 4, exportedAt: "2026-08-10T06:00:00Z", profile: { id: "profile", birthDate: "1990-05-20", sex: "male", heightCm: 180, editedAt: "2026-08-10T05:00:00Z" },
    pressureMeasurements: [], pulseMeasurements: [], headacheEpisodes: [],
    glucoseMeasurements: [{ id: "g1", measuredAt: "2026-08-10T05:30:00Z", editedAt: "2026-08-10T05:31:00Z", value: 5.6, format: "plasma", context: "fasting", comment: "" }],
    weightMeasurements: [{ id: "w1", measuredAt: "2026-08-10T05:30:00Z", editedAt: "2026-08-10T05:31:00Z", weight: 80, comment: "" }]
  };
  const parsed = await parseBackupFile({ size: 1000, text: async () => JSON.stringify(backup) });
  assert.equal(parsed.profile.heightCm, 180);
  assert.equal(glucoseStats(parsed.glucoseMeasurements).average, 5.6);
  assert.equal(parsed.weightMeasurements[0].weight, 80);

  const invalid = structuredClone(backup); invalid.profile.birthDate = "2999-01-01";
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(invalid) }), /дата рождения/);
});

test("названия справочников и количество лекарства нормализуются", () => {
  assert.equal(normalizedNameKey("  ИБУПРОФЕН  "), normalizedNameKey("Ибупрофен"));
  assert.equal(normalizedNameKey("Поясничный   отдел"), "поясничный отдел");
  assert.equal(parseMedicationAmount(" 1,5 "), 1.5);
  assert.equal(parseMedicationAmount("0,1"), 0.1);
  assert.equal(parseMedicationAmount("999,9"), 999.9);
  assert.equal(formatMedicationDose(1.5, "tablet"), "1,5 табл.");
  assert.throws(() => parseMedicationAmount("1,55"), /0,1-999,9/);
  assert.throws(() => parseMedicationAmount("0"), /0,1-999,9/);
  assert.throws(() => parseMedicationAmount("1000"), /0,1-999,9/);
});

test("продолжающиеся приступы ограничиваются выбранной частью тела", () => {
  const items = [{ id: "p1", bodyPartId: "body-head", endedAt: null }, { id: "p2", bodyPartId: "body-back", endedAt: null }];
  assert.equal(hasOngoingPainForBodyPart(items, "body-head"), true);
  assert.equal(hasOngoingPainForBodyPart(items, "body-leg"), false);
  assert.equal(hasOngoingPainForBodyPart(items, "body-head", "p1"), false);
});

test("backup версии 6 проверяет связи боли, дозировку и системную единицу", async () => {
  const backup = {
    format: "health-diary-backup", version: 6, exportedAt: "2026-08-10T08:00:00Z", profile: null,
    pressureMeasurements: [], pulseMeasurements: [], glucoseMeasurements: [], weightMeasurements: [],
    bodyParts: [{ id: "body-back", name: "Спина", editedAt: "2026-08-10T05:00:00Z" }],
    medications: [{ id: "med-1", name: "Ибупрофен", editedAt: "2026-08-10T05:00:00Z" }],
    painEpisodes: [{ id: "pain-1", bodyPartId: "body-back", startedAt: "2026-08-10T05:00:00Z", endedAt: null, intensityMin: 3, intensityMax: 7, medicationId: "med-1", medicationAmount: 1.5, medicationUnitId: "tablet", medicationTakenAt: "2026-08-10T05:30:00Z", comment: "", editedAt: "2026-08-10T06:00:00Z" }]
  };
  const parsed = await parseBackupFile({ size: 1000, text: async () => JSON.stringify(backup) });
  assert.equal(parsed.painEpisodes[0].bodyPartId, "body-back");
  assert.equal(parsed.painEpisodes[0].medicationAmount, 1.5);
  assert.deepEqual(parsed.medicationCourses, []);
  assert.deepEqual(parsed.medicationIntakes, []);
  const badUnit = structuredClone(backup); badUnit.painEpisodes[0].medicationUnitId = "custom";
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(badUnit) }), /количество и единицу/);
  const excessiveAmount = structuredClone(backup); excessiveAmount.painEpisodes[0].medicationAmount = 1000;
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(excessiveAmount) }), /количество и единицу/);
  const migratedDose = structuredClone(backup); migratedDose.painEpisodes[0].medicationAmount = null; migratedDose.painEpisodes[0].medicationUnitId = null;
  assert.equal((await parseBackupFile({ size: 1000, text: async () => JSON.stringify(migratedDose) })).painEpisodes[0].medicationTakenAt, "2026-08-10T05:30:00.000Z");
  const missingPart = structuredClone(backup); missingPart.painEpisodes[0].bodyPartId = "missing";
  await assert.rejects(() => parseBackupFile({ size: 1000, text: async () => JSON.stringify(missingPart) }), /ID или даты/);
});

test("времена приёма распределяются по частям суток на граничных значениях", () => {
  assert.equal(dayPartForTime("00:00"), "night");
  assert.equal(dayPartForTime("05:59"), "night");
  assert.equal(dayPartForTime("06:00"), "morning");
  assert.equal(dayPartForTime("11:59"), "morning");
  assert.equal(dayPartForTime("12:00"), "day");
  assert.equal(dayPartForTime("17:59"), "day");
  assert.equal(dayPartForTime("18:00"), "evening");
  assert.equal(dayPartForTime("23:59"), "evening");
});

test("завершённые курсы отделяются от текущих", () => {
  assert.equal(isCourseCompletedOn({ archived: false, endDate: null }, "2026-08-18"), false);
  assert.equal(isCourseCompletedOn({ archived: false, endDate: "2026-08-18" }, "2026-08-18"), false);
  assert.equal(isCourseCompletedOn({ archived: false, endDate: "2026-08-17" }, "2026-08-18"), true);
  assert.equal(isCourseCompletedOn({ archived: true, endDate: null }, "2026-08-18"), true);
});

test("схема курса сортируется и отклоняет повторы", () => {
  assert.deepEqual(normalizeSchedule(["21:00", "09:00", "12:00"]), ["09:00", "12:00", "21:00"]);
  assert.throws(() => normalizeSchedule(["09:00", "09:00"]), /повторяться/);
  assert.throws(() => normalizeSchedule(["24:00"]), /ЧЧ:ММ/);
});

test("расписание дня вычисляется из активных курсов и истории", () => {
  const course = validateMedicationCourse({ id: "course-1", medicationId: "med-1", amount: "1,5", unitId: "tablet", startDate: "2026-08-10", endDate: null, schedule: ["18:00", "06:00"], foodRelation: "after", comment: "", archived: false }, new Set(["med-1"]));
  const intake = { id: "take-1", courseId: course.id, scheduledDate: "2026-08-17", scheduledTime: "06:00", status: "taken", amount: 1.5, unitId: "tablet" };
  const groups = buildDaySchedule([course], [intake], "2026-08-17");
  assert.equal(groups.morning[0].history.id, "take-1");
  assert.equal(groups.evening[0].history, null);
  assert.equal(buildDaySchedule([course], [], "2026-08-09").morning.length, 0);
});

test("расписание дня сортируется по времени, приёму пищи и названию лекарства", () => {
  const medicationNames = [
    { id: "med-zinc", name: "Zinc" }, { id: "med-aspirin", name: "Aspirin" },
    { id: "med-ru-a", name: "Аспирин" }, { id: "med-ru-i", name: "Ибупрофен" },
    { id: "med-during", name: "Aardvark" }, { id: "med-after", name: "Aardvark" }, { id: "med-any", name: "Aardvark" }, { id: "med-later", name: "Aardvark" }
  ];
  const course = (id, medicationId, time, foodRelation) => ({ id, medicationId, amount: 1, unitId: "tablet", startDate: "2026-08-10", endDate: null, schedule: [time], foodRelation, archived: false });
  const courses = [
    course("course-any", "med-any", "06:00", "any"), course("course-after", "med-after", "06:00", "after"),
    course("course-during", "med-during", "06:00", "during"), course("course-ru-i", "med-ru-i", "06:00", "before"),
    course("course-zinc", "med-zinc", "06:00", "before"), course("course-ru-a", "med-ru-a", "06:00", "before"),
    course("course-aspirin", "med-aspirin", "06:00", "before"), course("course-later", "med-later", "07:00", "before")
  ];
  const order = buildDaySchedule(courses, [], "2026-08-17", medicationNames).morning.map((item) => item.course.medicationId);
  assert.deepEqual(order, ["med-aspirin", "med-zinc", "med-ru-a", "med-ru-i", "med-during", "med-after", "med-any", "med-later"]);
});

test("статистика лекарств рассчитывается из плана и истории", () => {
  const course = { id: "course-1", medicationId: "med-1", amount: 1, unitId: "tablet", startDate: "2026-08-16", endDate: "2026-08-17", schedule: ["09:00", "21:00"], foodRelation: "any", archived: false };
  const intakes = [
    { courseId: course.id, scheduledDate: "2026-08-16", scheduledTime: "09:00", status: "taken", amount: 1 },
    { courseId: course.id, scheduledDate: "2026-08-16", scheduledTime: "21:00", status: "skipped", amount: 1 }
  ];
  const stats = medicationStatistics([course], intakes, "2026-08-16", "2026-08-17");
  assert.deepEqual({ planned: stats.planned, taken: stats.taken, skipped: stats.skipped, adherence: stats.adherence }, { planned: 4, taken: 1, skipped: 1, adherence: 25 });
});

test("backup версии 7 проверяет курсы и историю приёмов", async () => {
  const backup = {
    format: "health-diary-backup", version: 7, exportedAt: "2026-08-17T08:00:00Z", profile: null,
    pressureMeasurements: [], pulseMeasurements: [], painEpisodes: [], glucoseMeasurements: [], weightMeasurements: [],
    bodyParts: [{ id: "body-head", name: "Голова", editedAt: "2026-08-17T05:00:00Z" }],
    medications: [{ id: "med-1", name: "Ибупрофен", editedAt: "2026-08-17T05:00:00Z" }],
    medicationCourses: [{ id: "course-1", medicationId: "med-1", amount: 1, unitId: "tablet", startDate: "2026-08-10", endDate: null, schedule: ["09:00"], foodRelation: "after", comment: "", archived: false, editedAt: "2026-08-17T05:00:00Z" }],
    medicationIntakes: [{ id: "take-1", courseId: "course-1", scheduledDate: "2026-08-16", scheduledTime: "09:00", actualTakenAt: "2026-08-16T06:05:00Z", status: "taken", amount: 1, unitId: "tablet", foodRelation: "after", comment: "", editedAt: "2026-08-16T06:06:00Z" }]
  };
  const parsed = await parseBackupFile({ size: 2000, text: async () => JSON.stringify(backup) });
  assert.equal(parsed.medicationCourses[0].schedule[0], "09:00");
  assert.equal(parsed.medicationIntakes[0].status, "taken");
  const invalid = structuredClone(backup); invalid.medicationCourses[0].schedule = ["09:00", "09:00"];
  await assert.rejects(() => parseBackupFile({ size: 2000, text: async () => JSON.stringify(invalid) }), /повторяться/);
});

test("первичный интерфейс выбирается по надёжным признакам ОС и сразу сохраняется", () => {
  const cases = [
    [{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone" }, "modern"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", platform: "MacIntel", maxTouchPoints: 5 }, "modern"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)", platform: "MacIntel", maxTouchPoints: 0 }, "modern"],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" }, "classic"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 15)", platform: "Linux armv8l", maxTouchPoints: 5 }, "classic"],
    [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" }, "classic"],
    [{ userAgent: "Unknown", platform: "Unknown" }, "classic"],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0) Macintosh", platform: "MacIntel" }, "classic"]
  ];
  for (const [navigatorLike, expected] of cases) {
    const storage = memoryStorage();
    const settings = initializeUiSettings({ storage, navigatorLike });
    assert.equal(settings.interface, expected);
    assert.equal(readUiSettings(storage).interface, expected);
    assert.equal(settings.glassTransparency, DEFAULT_GLASS_TRANSPARENCY);
  }
});

test("сохранённый интерфейс применяется без определения ОС", () => {
  for (const [savedInterface, navigatorLike] of [["classic", { platform: "MacIntel" }], ["modern", { platform: "Win32" }]]) {
    const storage = memoryStorage(); saveUiSettings({ interface: savedInterface, glassTransparency: 31 }, storage);
    let detections = 0;
    const settings = initializeUiSettings({ storage, navigatorLike, detect: () => { detections += 1; return "classic"; } });
    assert.equal(settings.interface, savedInterface); assert.equal(settings.glassTransparency, 31); assert.equal(detections, 0);
  }
});

test("ручной выбор перезаписывается, следующий запуск не определяет ОС, а очистка запускает выбор снова", () => {
  const storage = memoryStorage(); let detections = 0;
  const detect = () => { detections += 1; return "classic"; };
  initializeUiSettings({ storage, detect });
  saveUiSettings({ interface: "modern", glassTransparency: 45 }, storage);
  assert.equal(initializeUiSettings({ storage, detect }).interface, "modern"); assert.equal(detections, 1);
  storage.removeItem(UI_SETTINGS_KEY);
  assert.equal(initializeUiSettings({ storage, detect }).interface, "classic"); assert.equal(detections, 2);
});

test("повреждённая настройка безопасно заменяется и не хранит источник выбора", () => {
  const storage = memoryStorage(); storage.setItem(UI_SETTINGS_KEY, "{broken");
  const settings = initializeUiSettings({ storage, detect: () => "classic" });
  assert.deepEqual(settings, { interface: "classic", glassTransparency: 25 });
  const persisted = JSON.parse(storage.getItem(UI_SETTINGS_KEY));
  assert.deepEqual(Object.keys(persisted).sort(), ["glassTransparency", "interface"]);
  assert.equal(JSON.stringify(persisted).includes("auto"), false); assert.equal(JSON.stringify(persisted).includes("manual"), false);
});

test("backup v8 экспортирует данные и настройки интерфейса без ОС и источника выбора", () => {
  const data = { ...emptyBackupData, profile: { id: "profile", heightCm: 180 }, weightMeasurements: [{ id: "w1", weight: 80 }], pressureMeasurements: [{ id: "p1", systolic: 120 }] };
  for (const interfaceName of ["classic", "modern"]) for (const transparency of [10, 25, 45]) {
    const payload = createBackupPayload(data, { interface: interfaceName, glassTransparency: transparency }, "2026-08-21T10:15:30.000Z");
    assert.equal(payload.version, 8); assert.equal(payload.exportedAt, "2026-08-21T10:15:30.000Z");
    assert.equal(payload.profile.heightCm, 180); assert.equal(payload.weightMeasurements[0].weight, 80); assert.equal(payload.pressureMeasurements[0].systolic, 120);
    assert.deepEqual(payload.settings, { interface: interfaceName, glassTransparency: transparency });
    const json = JSON.stringify(payload); assert.equal(/auto|manual|operatingSystem|userAgent/i.test(json), false);
  }
});

test("backup v8 проходит полный цикл разбора и восстанавливает настройки", async () => {
  const record = { id: "w1", measuredAt: "2026-08-20T08:00:00.000Z", editedAt: "2026-08-20T08:01:00.000Z", weight: 82, comment: "" };
  const payload = createBackupPayload({ ...emptyBackupData, weightMeasurements: [record] }, { interface: "modern", glassTransparency: 37 }, "2026-08-21T10:15:30.000Z");
  const parsed = await parseBackupFile(backupFile(payload));
  assert.equal(parsed.weightMeasurements[0].weight, 82); assert.deepEqual(parsed.uiSettings, { interface: "modern", glassTransparency: 37 });
});

test("backup v8 отклоняет некорректный интерфейс, прозрачность и JSON до применения", async () => {
  const valid = createBackupPayload(emptyBackupData, { interface: "classic", glassTransparency: 25 }, "2026-08-21T10:15:30.000Z");
  for (const settings of [{ interface: "automatic", glassTransparency: 25 }, { interface: "modern", glassTransparency: 9 }, { interface: "modern", glassTransparency: 46 }]) {
    await assert.rejects(() => parseBackupFile(backupFile({ ...valid, settings })), /настройки интерфейса/);
  }
  await assert.rejects(() => parseBackupFile({ size: 8, text: async () => "{broken" }), /прочитать JSON/);
});

test("старая резервная копия не удаляет текущие настройки интерфейса", async () => {
  const legacy = { format: "health-diary-backup", version: 7, exportedAt: "2026-08-17T08:00:00Z", ...emptyBackupData };
  const parsed = await parseBackupFile(backupFile(legacy));
  assert.equal(parsed.uiSettings, null);
});

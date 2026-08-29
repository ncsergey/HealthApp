import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isFuture, moscowDateTimeInputToIso, moscowInputToIso } from "../js/datetime.js";
import { parseBackupFile } from "../js/import.js";
import { ageOnDate, calculateBmi, evaluateBmi, evaluateGlucose, evaluatePressure, evaluatePulse, isBirthdayOnDate } from "../js/medical.js";
import { formatMedicationDose, hasOngoingPainForBodyPart, normalizedNameKey, parseMedicationAmount } from "../js/pain.js";
import { filterDataForPeriod, glucoseStats, headacheStats, overviewStats, pressureStats, pulseStats, weightStats } from "../js/statistics.js";
import { buildDaySchedule, dayPartForTime, isCourseCompletedOn, medicationStatistics, normalizeSchedule, validateMedicationCourse } from "../js/medications.js";
import { createBackupPayload } from "../js/export.js";
import { DEFAULT_GLASS_BLUR_INTENSITY, DEFAULT_GLASS_TRANSPARENCY, DEFAULT_THEME, UI_SETTINGS_KEY, UI_THEME_KEY, applyGlassBlurIntensity, applyGlassTransparency, applyTheme, applyUiSettings, initializeTheme, initializeUiSettings, readTheme, readUiSettings, saveTheme, saveUiSettings } from "../js/interface-settings.js";

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
    assert.equal(settings.glassEffects, "reduced");
    assert.equal(settings.glassBlurIntensity, DEFAULT_GLASS_BLUR_INTENSITY);
  }
});

test("тема по умолчанию следует устройству и сохраняется независимо от остальных настроек", () => {
  const storage = memoryStorage();
  saveUiSettings({ interface: "modern", glassTransparency: 37, glassEffects: "full", glassBlurIntensity: 55 }, storage);
  assert.equal(initializeTheme({ storage }), DEFAULT_THEME);
  assert.equal(storage.getItem(UI_THEME_KEY), "auto");
  for (const theme of ["light", "dark", "auto"]) {
    assert.equal(saveTheme(theme, storage), theme);
    assert.equal(readTheme(storage), theme);
    assert.deepEqual(readUiSettings(storage), { interface: "modern", glassTransparency: 37, glassEffects: "full", glassBlurIntensity: 55 });
  }
  storage.setItem(UI_THEME_KEY, "sepia");
  assert.equal(initializeTheme({ storage }), "auto");
  assert.throws(() => saveTheme("sepia", storage), /тема интерфейса/);
  const root = { dataset: {} };
  assert.equal(applyTheme("dark", root), "dark");
  assert.deepEqual(root.dataset, { theme: "dark" });
  assert.throws(() => applyTheme("sepia", root), /тема интерфейса/);
});

test("переключатель темы содержит только эмодзи и доступные описания", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const [theme, emoji, label] of [["auto", "📱", "Авто — тема определяется устройством"], ["light", "☀️", "Светлая — светлая тема"], ["dark", "🌙", "Тёмная — тёмная тема"]]) {
    assert.match(html, new RegExp(`data-theme-choice="${theme}"[^>]+aria-label="${label}"[^>]*><span aria-hidden="true">${emoji}<\\/span><\\/button>`));
  }
});

test("CSS поддерживает системную и обе принудительные темы", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /html\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  assert.match(css, /:root\[data-theme="auto"\]/);
  assert.match(css, /html\[data-theme="dark"\]\[data-interface="modern"\]/);
});

test("старые настройки мигрируют на интенсивность 100 без потери остальных полей", () => {
  const storage = memoryStorage();
  storage.setItem(UI_SETTINGS_KEY, JSON.stringify({ interface: "modern", glassTransparency: 60, glassEffects: "full" }));
  assert.deepEqual(initializeUiSettings({ storage, detect: () => "classic" }), { interface: "modern", glassTransparency: 60, glassEffects: "full", glassBlurIntensity: 100 });
  assert.deepEqual(JSON.parse(storage.getItem(UI_SETTINGS_KEY)), { interface: "modern", glassTransparency: 60, glassEffects: "full", glassBlurIntensity: 100 });
});

test("все режимы и обе интенсивности сохраняются без повторного определения ОС", () => {
  for (const [savedInterface, navigatorLike] of [["classic", { platform: "MacIntel" }], ["modern", { platform: "Win32" }]]) for (const glassEffects of ["full", "reduced", "none"]) {
    const storage = memoryStorage(); saveUiSettings({ interface: savedInterface, glassTransparency: 31, glassEffects, glassBlurIntensity: 57 }, storage);
    let detections = 0;
    const settings = initializeUiSettings({ storage, navigatorLike, detect: () => { detections += 1; return "classic"; } });
    assert.deepEqual(settings, { interface: savedInterface, glassTransparency: 31, glassEffects, glassBlurIntensity: 57 }); assert.equal(detections, 0);
  }
});

test("границы прозрачности и размытия сохраняются и восстанавливаются", () => {
  for (const glassTransparency of [10, 60]) for (const glassBlurIntensity of [25, 100]) {
    const storage = memoryStorage();
    saveUiSettings({ interface: "modern", glassTransparency, glassEffects: "full", glassBlurIntensity }, storage);
    assert.deepEqual(readUiSettings(storage), { interface: "modern", glassTransparency, glassEffects: "full", glassBlurIntensity });
  }
});

test("режим, интерфейс, прозрачность и размытие изменяются независимо", () => {
  const storage = memoryStorage(); let detections = 0;
  const detect = () => { detections += 1; return "classic"; };
  initializeUiSettings({ storage, detect });
  saveUiSettings({ interface: "modern", glassTransparency: 60, glassEffects: "reduced", glassBlurIntensity: 37 }, storage);
  saveUiSettings({ ...readUiSettings(storage), glassEffects: "none" }, storage);
  assert.deepEqual(initializeUiSettings({ storage, detect }), { interface: "modern", glassTransparency: 60, glassEffects: "none", glassBlurIntensity: 37 }); assert.equal(detections, 1);
  saveUiSettings({ ...readUiSettings(storage), glassBlurIntensity: 81 }, storage);
  assert.deepEqual(readUiSettings(storage), { interface: "modern", glassTransparency: 60, glassEffects: "none", glassBlurIntensity: 81 });
  saveUiSettings({ ...readUiSettings(storage), interface: "classic" }, storage);
  assert.deepEqual(readUiSettings(storage), { interface: "classic", glassTransparency: 60, glassEffects: "none", glassBlurIntensity: 81 });
  saveUiSettings({ ...readUiSettings(storage), interface: "modern" }, storage);
  saveUiSettings({ ...readUiSettings(storage), glassEffects: "full" }, storage);
  assert.deepEqual(readUiSettings(storage), { interface: "modern", glassTransparency: 60, glassEffects: "full", glassBlurIntensity: 81 });
  storage.removeItem(UI_SETTINGS_KEY);
  assert.equal(initializeUiSettings({ storage, detect }).interface, "classic"); assert.equal(detections, 2);
});

test("повреждённые поля заменяются отдельно и storage не хранит источник выбора", () => {
  const storage = memoryStorage(); storage.setItem(UI_SETTINGS_KEY, "{broken");
  const settings = initializeUiSettings({ storage, detect: () => "classic" });
  assert.deepEqual(settings, { interface: "classic", glassTransparency: 25, glassEffects: "reduced", glassBlurIntensity: 100 });
  for (const glassTransparency of [9, 61, 25.5, "25", null]) {
    storage.setItem(UI_SETTINGS_KEY, JSON.stringify({ interface: "modern", glassTransparency, glassEffects: "full", glassBlurIntensity: 55 }));
    assert.deepEqual(initializeUiSettings({ storage, detect: () => "classic" }), { interface: "modern", glassTransparency: 25, glassEffects: "full", glassBlurIntensity: 55 });
  }
  for (const glassBlurIntensity of [24, 101, 50.5, "50", null]) {
    storage.setItem(UI_SETTINGS_KEY, JSON.stringify({ interface: "modern", glassTransparency: 37, glassEffects: "full", glassBlurIntensity }));
    assert.deepEqual(initializeUiSettings({ storage, detect: () => "classic" }), { interface: "modern", glassTransparency: 37, glassEffects: "full", glassBlurIntensity: 100 });
  }
  storage.setItem(UI_SETTINGS_KEY, JSON.stringify({ interface: "modern", glassTransparency: 37, glassEffects: "turbo", glassBlurIntensity: 55, auto: true, deviceModel: "x" }));
  assert.deepEqual(initializeUiSettings({ storage, detect: () => "classic" }), { interface: "modern", glassTransparency: 37, glassEffects: "reduced", glassBlurIntensity: 55 });
  const persisted = JSON.parse(storage.getItem(UI_SETTINGS_KEY));
  assert.deepEqual(Object.keys(persisted).sort(), ["glassBlurIntensity", "glassEffects", "glassTransparency", "interface"]);
  assert.equal(JSON.stringify(persisted).includes("auto"), false); assert.equal(JSON.stringify(persisted).includes("manual"), false);
  assert.equal(JSON.stringify(persisted).includes("deviceModel"), false);
});

test("режим применяется атрибутом темы и сохраняется при классическом интерфейсе", () => {
  const properties = new Map();
  const root = { dataset: {}, style: { setProperty: (name, value) => properties.set(name, value) } };
  applyUiSettings({ interface: "classic", glassTransparency: 60, glassEffects: "reduced", glassBlurIntensity: 25 }, root);
  assert.deepEqual(root.dataset, { interface: "classic", glassEffects: "reduced" });
  assert.equal(properties.get("--glass-transparency"), "60%");
  assert.equal(properties.get("--glass-blur-scale"), "0.25");
  applyUiSettings({ interface: "modern", glassTransparency: 60, glassEffects: "reduced", glassBlurIntensity: 25 }, root);
  assert.deepEqual(root.dataset, { interface: "modern", glassEffects: "reduced" });
});

test("оба ползунка допускают дробный preview, не записывая его, и сохраняют округлённое целое", () => {
  const properties = new Map();
  const root = { style: { setProperty: (name, value) => properties.set(name, value) } };
  const storage = memoryStorage();
  saveUiSettings({ interface: "modern", glassTransparency: 25, glassEffects: "reduced", glassBlurIntensity: 100 }, storage);
  assert.equal(applyGlassTransparency(27.42, root), 27.42);
  assert.equal(applyGlassBlurIntensity(53.67, root), 53.67);
  assert.equal(properties.get("--glass-transparency"), "27.42%");
  assert.equal(properties.get("--glass-opacity"), "72.58%");
  assert.equal(properties.get("--glass-blur-intensity"), "53.67%");
  assert.equal(properties.get("--glass-blur-scale"), "0.5367");
  applyGlassTransparency(60, root);
  assert.equal(properties.get("--glass-blur-scale"), "0.5367");
  applyGlassBlurIntensity(25, root);
  assert.equal(properties.get("--glass-transparency"), "60%");
  assert.deepEqual(readUiSettings(storage), { interface: "modern", glassTransparency: 25, glassEffects: "reduced", glassBlurIntensity: 100 });
  const committed = saveUiSettings({ ...readUiSettings(storage), glassTransparency: Math.round(27.42), glassBlurIntensity: Math.round(53.67) }, storage);
  assert.deepEqual(committed, { interface: "modern", glassTransparency: 27, glassEffects: "reduced", glassBlurIntensity: 54 });
});

test("ползунки доступны, имеют дробный drag и отдельную клавиатурную обработку по 1%", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  assert.match(html, /<label for="glass-transparency">Прозрачность<\/label>/);
  assert.match(html, /<output id="glass-transparency-value" for="glass-transparency">/);
  assert.match(html, /id="glass-transparency"[^>]+min="10"[^>]+max="60"[^>]+step="0\.01"/);
  assert.match(html, /<label for="glass-blur-intensity">Размытие<\/label>/);
  assert.match(html, /<output id="glass-blur-value" for="glass-blur-intensity">/);
  assert.match(html, /id="glass-blur-intensity"[^>]+min="25"[^>]+max="100"[^>]+step="0\.01"/);
  assert.equal((html.match(/class="unified-range-control(?: pain-range-control)?"/g) || []).length, 5);
  assert.equal((html.match(/class="unified-range-track"/g) || []).length, 5);
  assert.equal((html.match(/class="unified-range-fill"/g) || []).length, 5);
  assert.match(html, /Размытие отключено выбранным режимом/);
  assert.match(app, /handleGlassTransparencyKeydown[\s\S]+Math\.round\(Number\(event\.currentTarget\.value\)\) \+ direction/);
  assert.match(app, /handleGlassBlurIntensityKeydown[\s\S]+Math\.round\(Number\(event\.currentTarget\.value\)\) \+ direction/);
  assert.match(app, /syncGlassRangeProgress[\s\S]+closest\("\.unified-range-control"\)[\s\S]+--range-progress/);
  assert.match(css, /--transparency-range: #286dcc/);
  assert.match(css, /--blur-range: #c93f55/);
  assert.match(css, /\.blur-card \.unified-range-control \{ --range-fill: var\(--blur-range\); \}/);
  assert.match(css, /\.unified-range-track \{[\s\S]+overflow: hidden[\s\S]+background: var\(--intensity-track\)/);
  assert.match(css, /\.unified-range-fill \{[\s\S]+width: var\(--range-progress\)[\s\S]+background: var\(--range-fill\)/);
  assert.match(css, /\.unified-range-control input\[type="range"\] \{[\s\S]+border-radius: 999px/);
  assert.match(css, /\.unified-range-control input\[type="range"\]::\-webkit-slider-runnable-track[\s\S]+-webkit-appearance: none[\s\S]+box-shadow: none/);
  assert.match(css, /\.unified-range-control input\[type="range"\]::\-webkit-slider-thumb[\s\S]+width: 26px[\s\S]+border: 3px solid var\(--intensity-thumb-border\)/);
  const modernFieldStyle = css.indexOf('html[data-interface="modern"] .field input,');
  const sharedSurfaceReset = css.indexOf('html .unified-range-control > input[type="range"]');
  assert.ok(modernFieldStyle >= 0 && sharedSurfaceReset > modernFieldStyle);
  assert.match(css, /html \.unified-range-control > input\[type="range"\] \{[\s\S]+border: 0[\s\S]+background: transparent[\s\S]+box-shadow: none[\s\S]+-webkit-backdrop-filter: none/);
});

test("CSS масштабирует full, ограничивает reduced и полностью отключает blur в none", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  for (const line of css.split(/\r?\n/).filter((line) => line.includes("data-glass-effects"))) assert.match(line, /data-interface="modern"/);
  assert.match(css, /\.app-header[\s\S]+blur\(calc\(28px \* var\(--glass-blur-scale\)\)\)/);
  assert.match(css, /\.bottom-nav[\s\S]+blur\(calc\(28px \* var\(--glass-blur-scale\)\)\)/);
  assert.match(css, /\.entry-card[\s\S]+blur\(calc\(22px \* var\(--glass-blur-scale\)\)\)/);
  assert.match(css, /data-glass-effects="reduced"[^}]+backdrop-filter: none !important/s);
  assert.match(css, /data-glass-effects="reduced"\] \.app-header \{ backdrop-filter: saturate\(125%\) blur\(calc\(12px \* var\(--glass-blur-scale\)\)\)/);
  assert.match(css, /data-glass-effects="reduced"\] \.bottom-nav \{ backdrop-filter: saturate\(130%\) blur\(calc\(14px \* var\(--glass-blur-scale\)\)\)/);
  assert.match(css, /data-glass-effects="reduced"\] dialog \{ backdrop-filter: saturate\(125%\) blur\(calc\(15px \* var\(--glass-blur-scale\)\)\)/);
  assert.doesNotMatch(css, /data-glass-effects="reduced"\] \.entry-card[^}]*backdrop-filter/);
  assert.match(css, /data-glass-effects="none"[^}]+backdrop-filter: none !important/s);
  assert.match(css, /data-glass-effects="none"[^}]+-webkit-backdrop-filter: none !important/s);
  assert.doesNotMatch(css, /transition:[^;]*(?:backdrop-filter|filter)/);
  assert.doesNotMatch(css, /will-change/);
});

test("в современном интерфейсе шапка и нижнее меню образуют симметричные плавающие панели", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  assert.match(css, /--floating-chrome-gap: 12px/);
  assert.match(css, /--floating-chrome-height: 71px/);
  assert.match(css, /--floating-chrome-width: min\(calc\(100% - 24px - var\(--safe-left\) - var\(--safe-right\)\), 680px\)/);
  assert.match(css, /--chrome-safe-top: var\(--safe-top\)/);
  assert.match(css, /--chrome-safe-bottom: var\(--safe-bottom\)/);
  assert.match(css, /html\[data-interface="modern"\] \.app-header \{[\s\S]+position: fixed[\s\S]+top: calc\(var\(--floating-chrome-gap\) \+ var\(--chrome-safe-top\)\)[\s\S]+left: 50%[\s\S]+width: var\(--floating-chrome-width\)[\s\S]+height: var\(--floating-chrome-height\)[\s\S]+transform: translateX\(-50%\)/);
  assert.match(css, /html\[data-interface="modern"\] \.bottom-nav \{[\s\S]+bottom: calc\(var\(--floating-chrome-gap\) \+ var\(--chrome-safe-bottom\)\)[\s\S]+left: 50%[\s\S]+width: var\(--floating-chrome-width\)[\s\S]+height: var\(--floating-chrome-height\)/);
  assert.match(css, /html\[data-interface="modern"\] \.app-main \{[\s\S]+padding-top: calc\(var\(--floating-chrome-gap\) \+ var\(--chrome-safe-top\) \+ var\(--floating-chrome-height\) \+ 18px\)[\s\S]+padding-bottom: calc\(var\(--floating-chrome-gap\) \+ var\(--chrome-safe-bottom\) \+ var\(--floating-chrome-height\) \+ 49px\)/);
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 500px\) \{[\s\S]+html\[data-interface="modern"\] body \{ padding-left: 0; \}[\s\S]+html\[data-interface="modern"\] \.bottom-nav \{[\s\S]+top: auto[\s\S]+bottom: calc\(var\(--floating-chrome-gap\) \+ var\(--chrome-safe-bottom\)\)[\s\S]+width: var\(--floating-chrome-width\)[\s\S]+height: var\(--floating-chrome-height\)[\s\S]+grid-template: 1fr \/ repeat\(4, minmax\(0, 1fr\)\)[\s\S]+transform: translateX\(-50%\)/);
  assert.doesNotMatch(css, /html\[data-interface="modern"\] \.bottom-nav \{[\s\S]{0,300}width: 78px/);
});

test("safe-area плавающих панелей синхронизируется после поворота, но не при скроллинге", () => {
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /function measureSafeAreaInsets\(\)[\s\S]+padding-top:env\(safe-area-inset-top,0px\)[\s\S]+padding-bottom:env\(safe-area-inset-bottom,0px\)[\s\S]+styles\.paddingTop[\s\S]+styles\.paddingBottom/);
  assert.match(app, /function syncChromeSafeInsets\(\)[\s\S]+measureSafeAreaInsets\(\)[\s\S]+--chrome-safe-top[\s\S]+--chrome-safe-bottom/);
  const chromeSync = app.match(/function syncChromeSafeInsets\(\) \{([\s\S]+?)\n\}/)?.[1] || "";
  assert.doesNotMatch(chromeSync, /visualViewport|offsetTop|viewportBottomInset/);
  assert.match(app, /chromeSafeInsetSyncTimers = \[0, 60, 180, 360, 720, 1200\]\.map/);
  assert.match(app, /function bindEvents\(\) \{\s+syncVisualViewport\(\);\s+scheduleChromeSafeInsetSync\(\)/);
  assert.match(app, /addEventListener\("orientationchange", scheduleChromeSafeInsetSync\)/);
  assert.match(app, /addEventListener\("resize", debounce\(handleViewportOrientationChange, 80\)\)/);
  assert.match(app, /handleVisualViewportChange = debounce\(\(\) => \{ syncVisualViewport\(\); ensureFocusedEntryFieldVisible\(\); \}, 80\)/);
  assert.doesNotMatch(app, /handleVisualViewportChange = debounce\([\s\S]{0,180}syncChromeSafeInsets/);
});

test("в современном интерфейсе дневниковые фильтры занимают всю ширину в альбомной ориентации", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 500px\) \{[\s\S]+html\[data-interface="modern"\] \.filter-scroll \{[\s\S]+overflow-x: visible[\s\S]+html\[data-interface="modern"\] \.filter-scroll::after \{[\s\S]+display: none[\s\S]+html\[data-interface="modern"\] \.diary-filters \{[\s\S]+width: 100%[\s\S]+min-width: 0[\s\S]+grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
});

test("эмодзи справочников используют обводку современных карточек", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-interface="modern"\] \.settings-icon,\s*html\[data-interface="modern"\] \.overview-icon,\s*html\[data-interface="modern"\] \.directory-choice-icon \{[^}]+border: 1px solid rgba\(255,255,255,\.62\)[^}]+box-shadow: inset 0 1px rgba\(255,255,255,\.7\)/);
});

test("PWA разрешает портретную и альбомную ориентации", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.orientation, "any");
});

test("ползунки боли используют общий компонент и насыщенный градиент", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  assert.equal((html.match(/class="unified-range-control pain-range-control"/g) || []).length, 3);
  assert.match(app, /updateIntensityDisplay[\s\S]+closest\("\.unified-range-control"\)[\s\S]+--range-progress/);
  assert.match(css, /--intensity-low: #16875f/);
  assert.match(css, /--intensity-high: #d33f49/);
  assert.match(css, /\.pain-range-control \{ --range-fill: linear-gradient\(to right, var\(--intensity-low\), var\(--intensity-medium\) 50%, var\(--intensity-high\)\); \}/);
  for (const source of [html, app, css]) assert.doesNotMatch(source, /(?:glass|intensity)-range-(?:control|track|fill)/);
});

test("backup v10 экспортирует обе настройки независимо от интерфейса без сведений об устройстве", () => {
  const data = { ...emptyBackupData, profile: { id: "profile", heightCm: 180 }, weightMeasurements: [{ id: "w1", weight: 80 }], pressureMeasurements: [{ id: "p1", systolic: 120 }] };
  for (const interfaceName of ["classic", "modern"]) for (const transparency of [10, 25, 60]) for (const glassEffects of ["full", "reduced", "none"]) for (const glassBlurIntensity of [25, 100]) {
    const payload = createBackupPayload(data, { interface: interfaceName, glassTransparency: transparency, glassEffects, glassBlurIntensity }, "2026-08-21T10:15:30.000Z");
    assert.equal(payload.version, 10); assert.equal(payload.exportedAt, "2026-08-21T10:15:30.000Z");
    assert.equal(payload.profile.heightCm, 180); assert.equal(payload.weightMeasurements[0].weight, 80); assert.equal(payload.pressureMeasurements[0].systolic, 120);
    assert.deepEqual(payload.settings, { interface: interfaceName, glassTransparency: transparency, glassEffects, glassBlurIntensity });
    const json = JSON.stringify(payload); assert.equal(/"(?:auto|manual|detected|device|deviceModel|model|operatingSystem|userAgent|source)"\s*:/i.test(json), false);
  }
  const repaired = createBackupPayload(data, { interface: "modern", glassTransparency: 25.5, glassEffects: "full", glassBlurIntensity: 50.5 });
  assert.deepEqual(repaired.settings, { interface: "modern", glassTransparency: 25, glassEffects: "full", glassBlurIntensity: 100 });
});

test("backup v10 проходит полный цикл и восстанавливает допустимые значения", async () => {
  const record = { id: "w1", measuredAt: "2026-08-20T08:00:00.000Z", editedAt: "2026-08-20T08:01:00.000Z", weight: 82, comment: "" };
  for (const glassEffects of ["full", "reduced", "none"]) for (const glassBlurIntensity of [25, 57, 100]) {
    const payload = createBackupPayload({ ...emptyBackupData, weightMeasurements: [record] }, { interface: "modern", glassTransparency: 60, glassEffects, glassBlurIntensity }, "2026-08-21T10:15:30.000Z");
    const parsed = await parseBackupFile(backupFile(payload));
    assert.equal(parsed.weightMeasurements[0].weight, 82); assert.deepEqual(parsed.uiSettings, { interface: "modern", glassTransparency: 60, glassEffects, glassBlurIntensity });
  }
});

test("backup v10 отклоняет неизвестные, дробные и выходящие за диапазон значения атомарно", async () => {
  const valid = createBackupPayload(emptyBackupData, { interface: "classic", glassTransparency: 25, glassEffects: "full", glassBlurIntensity: 100 }, "2026-08-21T10:15:30.000Z");
  for (const settings of [{ ...valid.settings, interface: "automatic" }, { ...valid.settings, glassTransparency: 9 }, { ...valid.settings, glassTransparency: 61 }, { ...valid.settings, glassTransparency: 25.5 }]) {
    await assert.rejects(() => parseBackupFile(backupFile({ ...valid, settings })), /настройки интерфейса/);
  }
  for (const glassEffects of ["turbo", null, 1]) await assert.rejects(() => parseBackupFile(backupFile({ ...valid, settings: { ...valid.settings, glassEffects } })), /режим эффектов/);
  for (const glassBlurIntensity of [24, 101, 50.5, "50", null]) await assert.rejects(() => parseBackupFile(backupFile({ ...valid, settings: { ...valid.settings, glassBlurIntensity } })), /интенсивность размытия/);
  const current = { records: ["unchanged"], settings: { interface: "modern", glassTransparency: 60, glassEffects: "none", glassBlurIntensity: 57 } };
  await assert.rejects(() => parseBackupFile({ size: 8, text: async () => "{broken" }), /прочитать JSON/);
  assert.deepEqual(current, { records: ["unchanged"], settings: { interface: "modern", glassTransparency: 60, glassEffects: "none", glassBlurIntensity: 57 } });
});

test("backup 1–9 сохраняют текущую интенсивность, а без текущего значения получают 100", async () => {
  const legacy = { format: "health-diary-backup", version: 7, exportedAt: "2026-08-17T08:00:00Z", ...emptyBackupData };
  const parsed = await parseBackupFile(backupFile(legacy));
  assert.equal(parsed.uiSettings, null);
  const version8 = { ...legacy, version: 8, settings: { interface: "classic", glassTransparency: 31 } };
  const parsed8 = await parseBackupFile(backupFile(version8));
  assert.deepEqual(parsed8.uiSettings, { interface: "classic", glassTransparency: 31 });
  const version9 = { ...legacy, version: 9, settings: { interface: "modern", glassTransparency: 60, glassEffects: "none" } };
  const parsed9 = await parseBackupFile(backupFile(version9));
  assert.deepEqual(parsed9.uiSettings, { interface: "modern", glassTransparency: 60, glassEffects: "none" });
  assert.deepEqual({ interface: "modern", glassTransparency: 45, glassEffects: "reduced", glassBlurIntensity: 57, ...parsed9.uiSettings }, { interface: "modern", glassTransparency: 60, glassEffects: "none", glassBlurIntensity: 57 });
  const storageWithoutCurrentIntensity = memoryStorage();
  assert.deepEqual(saveUiSettings(parsed9.uiSettings, storageWithoutCurrentIntensity), { interface: "modern", glassTransparency: 60, glassEffects: "none", glassBlurIntensity: 100 });
});

import { getDateKey } from "./datetime.js";
import { mean, rounded } from "./utils.js";

function inRange(value, bounds) {
  const time = new Date(value).getTime();
  return (!bounds.start || time >= bounds.start.getTime()) && time <= bounds.end.getTime();
}

export function filterDataForPeriod(data, bounds) {
  const painEpisodes = data.painEpisodes || data.headacheEpisodes || [];
  return {
    profile: data.profile || null,
    pressureMeasurements: data.pressureMeasurements.filter((item) => inRange(item.measuredAt, bounds)),
    pulseMeasurements: (data.pulseMeasurements || []).filter((item) => inRange(item.measuredAt, bounds)),
    painEpisodes: painEpisodes.filter((item) => inRange(item.startedAt, bounds)),
    headacheEpisodes: painEpisodes.filter((item) => inRange(item.startedAt, bounds)),
    glucoseMeasurements: (data.glucoseMeasurements || []).filter((item) => inRange(item.measuredAt, bounds)),
    weightMeasurements: (data.weightMeasurements || []).filter((item) => inRange(item.measuredAt, bounds))
  };
}

export function pressureStats(items) {
  if (!items.length) return null;
  const values = (key) => items.map((item) => item[key]);
  return {
    count: items.length,
    avgSystolic: rounded(mean(items, (item) => item.systolic)),
    avgDiastolic: rounded(mean(items, (item) => item.diastolic)),
    minSystolic: Math.min(...values("systolic")), maxSystolic: Math.max(...values("systolic")),
    minDiastolic: Math.min(...values("diastolic")), maxDiastolic: Math.max(...values("diastolic"))
  };
}

export function pulseStats(items) {
  if (!items.length) return null;
  const values = items.map((item) => item.pulse);
  return {
    count: items.length,
    average: rounded(mean(items, (item) => item.pulse)),
    min: Math.min(...values),
    max: Math.max(...values)
  };
}

export function glucoseStats(items, evaluate = null) {
  if (!items.length) return null;
  const values = items.map((item) => item.value);
  const byContext = new Map();
  const byFormat = new Map();
  const statusCounts = { low: 0, normal: 0, high: 0, critical: 0, insufficient: 0 };
  for (const item of items) {
    byContext.set(item.context, (byContext.get(item.context) || 0) + 1);
    byFormat.set(item.format, (byFormat.get(item.format) || 0) + 1);
    if (evaluate) {
      const status = evaluate(item);
      statusCounts[status.level] = (statusCounts[status.level] || 0) + 1;
    }
  }
  return {
    count: items.length,
    average: rounded(mean(items, (item) => item.value), 1),
    min: Math.min(...values), max: Math.max(...values),
    byContext: [...byContext.entries()], byFormat: [...byFormat.entries()], statusCounts
  };
}

export function weightStats(items) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
  const weights = sorted.map((item) => item.weight);
  return {
    count: sorted.length,
    first: sorted[0], current: sorted.at(-1),
    change: sorted.at(-1).weight - sorted[0].weight,
    min: Math.min(...weights), max: Math.max(...weights)
  };
}

function daysCoveredByEpisode(episode, upperBound) {
  const keys = new Set();
  const start = new Date(episode.startedAt);
  const end = episode.endedAt ? new Date(episode.endedAt) : upperBound;
  const cursor = new Date(start);
  while (cursor <= end && keys.size < 36_600) {
    keys.add(getDateKey(cursor));
    cursor.setTime(cursor.getTime() + 86_400_000);
  }
  keys.add(getDateKey(end));
  return keys;
}

export function painStats(items, now = new Date(), directories = {}) {
  if (!items.length) return null;
  const completed = items.filter((item) => item.endedAt);
  const durations = completed.map((item) => new Date(item.endedAt).getTime() - new Date(item.startedAt).getTime());
  const days = new Set();
  const medications = new Map(); const bodyParts = new Map();
  const medicationNames = new Map((directories.medications || []).map((item) => [item.id, item.name]));
  const bodyPartNames = new Map((directories.bodyParts || []).map((item) => [item.id, item.name]));
  for (const item of items) {
    for (const key of daysCoveredByEpisode(item, now)) days.add(key);
    const medication = medicationNames.get(item.medicationId) || item.medication?.trim() || "Без лекарства";
    const medicationEntry = medications.get(medication) || { episodes: 0, doses: 0, units: new Map() };
    medicationEntry.episodes += 1;
    if (Number.isFinite(item.medicationAmount)) { medicationEntry.doses += 1; medicationEntry.units.set(item.medicationUnitId, (medicationEntry.units.get(item.medicationUnitId) || 0) + item.medicationAmount); }
    medications.set(medication, medicationEntry);
    const bodyPart = bodyPartNames.get(item.bodyPartId) || "Голова";
    bodyParts.set(bodyPart, (bodyParts.get(bodyPart) || 0) + 1);
  }
  return {
    count: items.length, days: days.size,
    averageIntensityMin: rounded(mean(items, (item) => item.intensityMin ?? item.intensity), 1),
    averageIntensityMax: rounded(mean(items, (item) => item.intensityMax ?? item.intensity), 1),
    minIntensity: Math.min(...items.map((item) => item.intensityMin ?? item.intensity)), maxIntensity: Math.max(...items.map((item) => item.intensityMax ?? item.intensity)),
    averageDuration: durations.length ? mean(durations, (value) => value) : null,
    maxDuration: durations.length ? Math.max(...durations) : null,
    totalDuration: durations.length ? durations.reduce((sum, value) => sum + value, 0) : 0,
    completedCount: completed.length, ongoingCount: items.length - completed.length,
    medications: [...medications.entries()].sort((a, b) => b[1].episodes - a[1].episodes || a[0].localeCompare(b[0], "ru")),
    medicationDoseCount: [...medications.values()].reduce((sum, item) => sum + item.doses, 0),
    bodyParts: [...bodyParts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
  };
}

export const headacheStats = painStats;

export function isPressureDuringHeadache(pressure, headaches, now = new Date()) {
  const measuredAt = new Date(pressure.measuredAt).getTime();
  return headaches.some((headache) => {
    const start = new Date(headache.startedAt).getTime();
    const end = headache.endedAt ? new Date(headache.endedAt).getTime() : now.getTime();
    return start <= measuredAt && measuredAt <= end;
  });
}

export function overviewStats(data, bounds) {
  const filtered = filterDataForPeriod(data, bounds);
  const now = new Date();
  const allPain = data.painEpisodes || data.headacheEpisodes || [];
  const during = filtered.pressureMeasurements.filter((item) => isPressureDuringHeadache(item, allPain, now));
  const outside = filtered.pressureMeasurements.filter((item) => !isPressureDuringHeadache(item, allPain, now));
  return {
    pressureCount: filtered.pressureMeasurements.length,
    pulseCount: filtered.pulseMeasurements.length,
    headacheCount: filtered.painEpisodes.length,
    glucoseCount: filtered.glucoseMeasurements.length,
    weightCount: filtered.weightMeasurements.length,
    overall: pressureStats(filtered.pressureMeasurements), during: pressureStats(during), outside: pressureStats(outside)
  };
}

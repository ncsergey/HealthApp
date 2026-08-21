import { downloadBlob } from "./utils.js";
import { UNIT_BY_ID, formatMedicationAmount } from "./pain.js";

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows, columns) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\r\n");
  return `\ufeff${header}\r\n${body}${body ? "\r\n" : ""}`;
}

async function shareFiles(files, title) {
  if (!navigator.share || !navigator.canShare || !navigator.canShare({ files })) return "unavailable";
  try {
    await navigator.share({ files, title });
    return "shared";
  } catch (error) {
    if (error.name === "AbortError") return "cancelled";
    return "unavailable";
  }
}

export async function exportCsv(data) {
  const bodyPartNames = new Map((data.bodyParts || []).map((item) => [item.id, item.name]));
  const medicationNames = new Map((data.medications || []).map((item) => [item.id, item.name]));
  const painRows = (data.painEpisodes || []).map((item) => ({
    bodyPart: bodyPartNames.get(item.bodyPartId) || "",
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    intensityMin: item.intensityMin,
    intensityMax: item.intensityMax,
    medication: medicationNames.get(item.medicationId) || "",
    medicationAmount: formatMedicationAmount(item.medicationAmount),
    medicationUnit: UNIT_BY_ID[item.medicationUnitId]?.short || "",
    medicationTakenAt: item.medicationTakenAt,
    comment: item.comment
  }));
  const medicationCourseRows = (data.medicationCourses || []).map((item) => ({
    id: item.id, medicationId: item.medicationId, medication: medicationNames.get(item.medicationId) || "", amount: item.amount,
    unitId: item.unitId, startDate: item.startDate, endDate: item.endDate, foodRelation: item.foodRelation,
    comment: item.comment, archived: item.archived, editedAt: item.editedAt
  }));
  const medicationScheduleRows = (data.medicationCourses || []).flatMap((item) => item.schedule.map((time) => ({ courseId: item.id, time })));
  const definitions = [
    ["profile.csv", data.profile ? [data.profile] : [], ["id", "birthDate", "sex", "heightCm", "editedAt"]],
    ["pressure.csv", data.pressureMeasurements, ["id", "measuredAt", "editedAt", "systolic", "diastolic", "comment"]],
    ["pulse.csv", data.pulseMeasurements, ["id", "measuredAt", "editedAt", "pulse", "context", "spo2", "stress", "comment"]],
    ["pain.csv", painRows, ["bodyPart", "startedAt", "endedAt", "intensityMin", "intensityMax", "medication", "medicationAmount", "medicationUnit", "medicationTakenAt", "comment"]],
    ["glucose.csv", data.glucoseMeasurements, ["id", "measuredAt", "editedAt", "value", "format", "context", "comment"]],
    ["weight.csv", data.weightMeasurements, ["id", "measuredAt", "editedAt", "weight", "comment"]],
    ["medication-courses.csv", medicationCourseRows, ["id", "medicationId", "medication", "amount", "unitId", "startDate", "endDate", "foodRelation", "comment", "archived", "editedAt"]],
    ["medication-schedules.csv", medicationScheduleRows, ["courseId", "time"]]
  ];
  const files = definitions.map(([name, rows, columns]) => new File([toCsv(rows, columns)], name, { type: "text/csv;charset=utf-8" }));
  const shareResult = await shareFiles(files, "Экспорт MyHealth");
  if (shareResult === "shared" || shareResult === "cancelled") return shareResult === "shared";
  files.forEach((file, index) => setTimeout(() => downloadBlob(file, file.name), index * 350));
  return true;
}

export async function exportJson(data) {
  const exportedAt = new Date().toISOString();
  const backup = {
    format: "health-diary-backup",
    version: 7,
    exportedAt,
    profile: data.profile,
    pressureMeasurements: data.pressureMeasurements,
    pulseMeasurements: data.pulseMeasurements,
    painEpisodes: data.painEpisodes,
    glucoseMeasurements: data.glucoseMeasurements,
    weightMeasurements: data.weightMeasurements,
    bodyParts: data.bodyParts,
    medications: data.medications,
    medicationCourses: data.medicationCourses || [],
    medicationIntakes: data.medicationIntakes || []
  };
  const date = exportedAt.slice(0, 10);
  const file = new File([JSON.stringify(backup, null, 2)], `health-diary-backup-${date}.json`, { type: "application/json;charset=utf-8" });
  const shareResult = await shareFiles([file], "Резервная копия MyHealth");
  if (shareResult === "shared" || shareResult === "cancelled") return shareResult === "shared";
  downloadBlob(file, file.name);
  return true;
}

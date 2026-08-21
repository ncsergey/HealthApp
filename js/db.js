import { DEFAULT_BODY_PARTS, normalizeDirectoryName, normalizedNameKey, stableNameId } from "./pain.js";

const DB_NAME = "pressure-diary";
const DB_VERSION = 5;

export const STORES = Object.freeze({
  profile: "profile", pressure: "pressureMeasurements", pulse: "pulseMeasurements",
  pain: "painEpisodes", headache: "headacheEpisodes", glucose: "glucoseMeasurements",
  weight: "weightMeasurements", bodyParts: "bodyParts", medications: "medications",
  medicationCourses: "medicationCourses", medicationIntakes: "medicationIntakes"
});

const ACTIVE_STORES = Object.freeze([STORES.profile, STORES.pressure, STORES.pulse, STORES.pain, STORES.glucose, STORES.weight, STORES.bodyParts, STORES.medications, STORES.medicationCourses, STORES.medicationIntakes]);
const COLLECTIONS = Object.freeze([
  ["pressureMeasurements", STORES.pressure], ["pulseMeasurements", STORES.pulse], ["painEpisodes", STORES.pain],
  ["glucoseMeasurements", STORES.glucose], ["weightMeasurements", STORES.weight], ["bodyParts", STORES.bodyParts], ["medications", STORES.medications],
  ["medicationCourses", STORES.medicationCourses], ["medicationIntakes", STORES.medicationIntakes]
]);
let dbPromise;

function createMeasurementStore(db, name, dateKey = "measuredAt") {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, { keyPath: "id" });
  store.createIndex(dateKey, dateKey, { unique: false });
  store.createIndex("editedAt", "editedAt", { unique: false });
}

function createDirectoryStore(db, name) {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, { keyPath: "id" });
  store.createIndex("nameKey", "nameKey", { unique: true });
  store.createIndex("editedAt", "editedAt", { unique: false });
}

function directoryRecord(id, name, editedAt = new Date().toISOString()) {
  const normalized = normalizeDirectoryName(name);
  return { id, name: normalized, nameKey: normalizedNameKey(normalized), editedAt };
}

function migrateHeadaches(transaction) {
  if (!transaction.db.objectStoreNames.contains(STORES.headache)) return;
  const oldStore = transaction.objectStore(STORES.headache);
  const painStore = transaction.objectStore(STORES.pain);
  const medicationStore = transaction.objectStore(STORES.medications);
  oldStore.openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    const legacy = cursor.value;
    const medicationName = normalizeDirectoryName(legacy.medication);
    const medicationId = medicationName ? stableNameId("med", medicationName) : null;
    if (medicationId) medicationStore.put(directoryRecord(medicationId, medicationName, legacy.editedAt));
    painStore.put({
      id: legacy.id, bodyPartId: "body-head", startedAt: legacy.startedAt, endedAt: legacy.endedAt ?? null,
      intensityMin: legacy.intensityMin ?? legacy.intensity, intensityMax: legacy.intensityMax ?? legacy.intensity,
      medicationId, medicationAmount: null, medicationUnitId: null, medicationTakenAt: legacy.medicationTakenAt || null,
      comment: legacy.comment || "", editedAt: legacy.editedAt
    });
    cursor.continue();
  };
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      createMeasurementStore(db, STORES.pressure); createMeasurementStore(db, STORES.pulse);
      createMeasurementStore(db, STORES.headache, "startedAt"); createMeasurementStore(db, STORES.pain, "startedAt");
      createMeasurementStore(db, STORES.glucose); createMeasurementStore(db, STORES.weight);
      createMeasurementStore(db, STORES.medicationCourses, "startDate"); createMeasurementStore(db, STORES.medicationIntakes, "scheduledDate");
      createDirectoryStore(db, STORES.bodyParts); createDirectoryStore(db, STORES.medications);
      if (!db.objectStoreNames.contains(STORES.profile)) {
        const profile = db.createObjectStore(STORES.profile, { keyPath: "id" });
        profile.createIndex("editedAt", "editedAt", { unique: false });
      }
      const transaction = request.transaction;
      const now = new Date().toISOString();
      for (const item of DEFAULT_BODY_PARTS) transaction.objectStore(STORES.bodyParts).put(directoryRecord(item.id, item.name, now));
      if (event.oldVersion > 0 && event.oldVersion < 3) {
        const pressureStore = transaction.objectStore(STORES.pressure); const pulseStore = transaction.objectStore(STORES.pulse);
        pressureStore.openCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result; if (!cursor) return;
          const { pulse, ...pressure } = cursor.value;
          if (Number.isInteger(pulse) && pulse >= 20 && pulse <= 400) pulseStore.put({ id: pressure.id, measuredAt: pressure.measuredAt, editedAt: pressure.editedAt, pulse, context: "unknown", comment: pressure.comment || "" });
          cursor.update(pressure); cursor.continue();
        };
      }
      if (event.oldVersion > 0 && event.oldVersion < 4) migrateHeadaches(transaction);
    };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = () => reject(request.error || new Error("Не удалось открыть локальную базу данных."));
    request.onblocked = () => reject(new Error("Обновление базы заблокировано другой открытой вкладкой."));
  });
  return dbPromise;
}

function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("Ошибка IndexedDB.")); }); }
function transactionDone(transaction) { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error || new Error("Транзакция IndexedDB завершилась с ошибкой.")); transaction.onabort = () => reject(transaction.error || new Error("Транзакция IndexedDB отменена.")); }); }

function normalizePainRecord(item) {
  const { intensity, medication, ...record } = item;
  const medicationName = normalizeDirectoryName(medication);
  return { ...record, bodyPartId: item.bodyPartId || "body-head", intensityMin: item.intensityMin ?? intensity, intensityMax: item.intensityMax ?? intensity,
    medicationId: item.medicationId || (medicationName ? stableNameId("med", medicationName) : null),
    medicationAmount: Number.isFinite(item.medicationAmount) ? item.medicationAmount : null, medicationUnitId: item.medicationUnitId || null,
    medicationTakenAt: item.medicationTakenAt || null };
}

function normalizedDirectory(items) { return (items || []).map((item) => directoryRecord(item.id, item.name, item.editedAt)); }

export function normalizeData(data = {}) {
  const sourcePain = data.painEpisodes || data.headacheEpisodes || [];
  const legacyMedications = sourcePain.map((item) => normalizeDirectoryName(item.medication)).filter(Boolean).map((name) => directoryRecord(stableNameId("med", name), name));
  const bodyParts = normalizedDirectory(data.bodyParts?.length ? data.bodyParts : DEFAULT_BODY_PARTS);
  const medicationsByName = new Map([...normalizedDirectory(data.medications), ...legacyMedications].map((item) => [item.nameKey, item]));
  return { profile: data.profile || null, pressureMeasurements: data.pressureMeasurements || [],
    pulseMeasurements: (data.pulseMeasurements || []).map((item) => ({ ...item, context: item.context || "unknown", spo2: Number.isInteger(item.spo2) ? item.spo2 : null, stress: Number.isInteger(item.stress) ? item.stress : null })),
    painEpisodes: sourcePain.map(normalizePainRecord), glucoseMeasurements: data.glucoseMeasurements || [], weightMeasurements: data.weightMeasurements || [],
    bodyParts, medications: [...medicationsByName.values()], medicationCourses: data.medicationCourses || [], medicationIntakes: data.medicationIntakes || [] };
}

export async function getAllData() {
  const db = await openDatabase(); const transaction = db.transaction(ACTIVE_STORES, "readonly");
  const profilePromise = requestResult(transaction.objectStore(STORES.profile).get("profile"));
  const collectionPromises = COLLECTIONS.map(([, store]) => requestResult(transaction.objectStore(store).getAll()));
  const [profile, ...collections] = await Promise.all([profilePromise, ...collectionPromises]); await transactionDone(transaction);
  return normalizeData({ profile: profile || null, ...Object.fromEntries(COLLECTIONS.map(([key], index) => [key, collections[index]])) });
}

export async function saveRecord(storeName, record) { const db = await openDatabase(); const transaction = db.transaction(storeName, "readwrite"); transaction.objectStore(storeName).put(record); await transactionDone(transaction); return record; }
export async function saveDirectoryItem(storeName, item) { return saveRecord(storeName, directoryRecord(item.id, item.name, item.editedAt)); }
export async function saveProfile(profile) { return saveRecord(STORES.profile, { ...profile, id: "profile" }); }
export async function deleteRecord(storeName, id) { const db = await openDatabase(); const transaction = db.transaction(storeName, "readwrite"); transaction.objectStore(storeName).delete(id); await transactionDone(transaction); }
export async function deleteMedicationCourse(id) {
  const db = await openDatabase(); const transaction = db.transaction([STORES.medicationCourses, STORES.medicationIntakes], "readwrite");
  transaction.objectStore(STORES.medicationCourses).delete(id);
  const intakeStore = transaction.objectStore(STORES.medicationIntakes);
  intakeStore.openCursor().onsuccess = (event) => {
    const cursor = event.target.result; if (!cursor) return;
    if (cursor.value.courseId === id) cursor.delete();
    cursor.continue();
  };
  await transactionDone(transaction);
}

export async function replaceAllData(input) {
  const data = normalizeData(input); const db = await openDatabase(); const transaction = db.transaction(ACTIVE_STORES, "readwrite");
  for (const storeName of ACTIVE_STORES) transaction.objectStore(storeName).clear();
  if (data.profile) transaction.objectStore(STORES.profile).put({ ...data.profile, id: "profile" });
  for (const [key, storeName] of COLLECTIONS) for (const record of data[key]) transaction.objectStore(storeName).put(record);
  await transactionDone(transaction);
}

function mergeCollection(current, incoming) {
  const records = new Map(current.map((item) => [item.id, item])); let conflicts = 0; let imported = 0;
  for (const item of incoming) { const previous = records.get(item.id); if (previous) conflicts += 1; if (!previous || item.editedAt > previous.editedAt) { records.set(item.id, item); imported += 1; } }
  return { items: [...records.values()], conflicts, imported };
}

export async function mergeData(input) {
  const incomingData = normalizeData(input); const current = await getAllData(); let conflicts = 0; let imported = 0; const merged = { ...current };
  const remaps = { bodyParts: new Map(), medications: new Map() };
  for (const key of ["bodyParts", "medications"]) {
    const byName = new Map(current[key].map((item) => [item.nameKey, item])); const byId = new Map(current[key].map((item) => [item.id, item]));
    for (const item of incomingData[key]) {
      const sameName = byName.get(item.nameKey); const sameId = byId.get(item.id);
      if (sameName) { remaps[key].set(item.id, sameName.id); conflicts += 1; continue; }
      if (sameId) { remaps[key].set(item.id, sameId.id); conflicts += 1; continue; }
      byName.set(item.nameKey, item); byId.set(item.id, item); remaps[key].set(item.id, item.id); imported += 1;
    }
    merged[key] = [...byId.values()];
  }
  incomingData.painEpisodes = incomingData.painEpisodes.map((item) => ({ ...item, bodyPartId: remaps.bodyParts.get(item.bodyPartId) || item.bodyPartId, medicationId: item.medicationId ? remaps.medications.get(item.medicationId) || item.medicationId : null }));
  incomingData.medicationCourses = incomingData.medicationCourses.map((item) => ({ ...item, medicationId: remaps.medications.get(item.medicationId) || item.medicationId }));
  for (const key of ["pressureMeasurements", "pulseMeasurements", "painEpisodes", "glucoseMeasurements", "weightMeasurements", "medicationCourses", "medicationIntakes"]) { const result = mergeCollection(current[key], incomingData[key]); merged[key] = result.items; conflicts += result.conflicts; imported += result.imported; }
  if (incomingData.profile) { if (current.profile) conflicts += 1; if (!current.profile || incomingData.profile.editedAt > current.profile.editedAt) { merged.profile = incomingData.profile; imported += 1; } }
  await replaceAllData(merged); return { conflicts, imported };
}

export async function countImportConflicts(input) {
  const data = normalizeData(input); const current = await getAllData(); let conflicts = data.profile && current.profile ? 1 : 0;
  for (const [key] of COLLECTIONS) { const ids = new Set(current[key].map((item) => item.id)); conflicts += data[key].filter((item) => ids.has(item.id)).length; }
  return conflicts;
}

export { DB_NAME, DB_VERSION };

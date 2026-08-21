const MOSCOW_TZ = "Europe/Moscow";
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric"
});

const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const longDateFormatter = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TZ,
  weekday: "long",
  day: "numeric",
  month: "long"
});

function pad(value) {
  return String(value).padStart(2, "0");
}

export function getMoscowFields(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MOSCOW_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

export function moscowInputToIso(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Укажите корректные дату и время.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("Укажите корректные дату и время.");
  }
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute) - MOSCOW_OFFSET_MS);
  const roundTrip = getMoscowFields(instant);
  if (roundTrip.date !== date || roundTrip.time !== time) {
    throw new Error("Такой даты или времени не существует.");
  }
  return instant.toISOString();
}

export function moscowDateTimeInputToIso(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("Укажите корректные дату и время.");
  return moscowInputToIso(match[1], match[2]);
}

export function isFuture(value, now = new Date()) {
  const instant = value instanceof Date ? value : new Date(value);
  const reference = now instanceof Date ? now : new Date(now);
  return !Number.isNaN(instant.getTime()) && !Number.isNaN(reference.getTime()) && instant.getTime() > reference.getTime();
}

export function formatDate(value) {
  return dateFormatter.format(new Date(value));
}

export function formatTime(value) {
  return timeFormatter.format(new Date(value));
}

export function formatDateTime(value) {
  return `${formatDate(value)} ${formatTime(value)}`;
}

export function formatDayLabel(value) {
  const key = getMoscowFields(value).date;
  const today = getMoscowFields().date;
  const yesterday = getMoscowFields(new Date(Date.now() - 86_400_000)).date;
  if (key === today) return "Сегодня";
  if (key === yesterday) return "Вчера";
  const label = longDateFormatter.format(new Date(value));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const totalMinutes = Math.round(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  if (minutes || parts.length === 0) parts.push(`${minutes} мин`);
  return parts.join(" ");
}

export function getPeriodBounds(period, customStart = "", customEnd = "") {
  const now = new Date();
  if (period === "all") return { start: null, end: now };
  if (period === "custom") {
    const start = customStart ? new Date(moscowInputToIso(customStart, "00:00")) : null;
    const end = customEnd ? new Date(new Date(moscowInputToIso(customEnd, "23:59")).getTime() + 59_999) : now;
    if (!start || !customEnd) return { start: null, end: now, incomplete: true };
    if (start > end) return { start, end, invalid: true };
    return { start, end };
  }
  const days = Number(period);
  return { start: new Date(now.getTime() - days * 86_400_000), end: now };
}

export function getDateKey(value) {
  return getMoscowFields(value).date;
}

export function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export { MOSCOW_TZ };

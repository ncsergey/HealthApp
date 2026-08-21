import { formatDate } from "./datetime.js";

function cssColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function drawTimeChart(canvas, items, series, emptyMessage = "Недостаточно данных для графика") {
  const context = canvas.getContext("2d");
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(280, Math.floor(bounds.width));
  const height = Math.max(180, Math.floor(bounds.height));
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);

  const textColor = cssColor("--muted", "#66736f");
  const gridColor = cssColor("--line", "#dbe5e1");
  context.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = textColor;

  if (!items.length) {
    context.textAlign = "center";
    context.fillText(emptyMessage, width / 2, height / 2);
    return;
  }

  const timeValue = (item) => item.measuredAt || item.startedAt;
  const sorted = [...items].sort((a, b) => new Date(timeValue(a)) - new Date(timeValue(b)));
  const values = sorted.flatMap((item) => series.map((line) => line.value(item))).filter(Number.isFinite);
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  const valuePadding = Math.max(5, (maxValue - minValue) * .12);
  minValue = Math.max(0, Math.floor(minValue - valuePadding));
  maxValue = Math.ceil(maxValue + valuePadding);
  if (minValue === maxValue) maxValue += 10;

  const times = sorted.map((item) => new Date(timeValue(item)).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const left = 40;
  const right = 10;
  const top = 12;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = (time) => left + (maxTime === minTime ? plotWidth / 2 : ((time - minTime) / (maxTime - minTime)) * plotWidth);
  const y = (value) => top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;

  context.strokeStyle = gridColor;
  context.lineWidth = 1;
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const value = minValue + ((maxValue - minValue) * (4 - index)) / 4;
    const yPosition = top + (plotHeight * index) / 4;
    context.beginPath();
    context.moveTo(left, yPosition);
    context.lineTo(width - right, yPosition);
    context.stroke();
    context.fillStyle = textColor;
    context.fillText(String(Math.round(value)), left - 6, yPosition);
  }

  context.textBaseline = "top";
  context.textAlign = "left";
  context.fillText(formatDate(timeValue(sorted[0])), left, height - bottom + 9);
  context.textAlign = "right";
  context.fillText(formatDate(timeValue(sorted.at(-1))), width - right, height - bottom + 9);

  for (const line of series) {
    context.strokeStyle = cssColor(line.color, line.fallback);
    context.fillStyle = context.strokeStyle;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    sorted.forEach((item, index) => {
      const pointX = x(new Date(timeValue(item)).getTime());
      const pointY = y(line.value(item));
      if (index === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.stroke();
    if (sorted.length <= 60) {
      for (const item of sorted) {
        context.beginPath();
        context.arc(x(new Date(timeValue(item)).getTime()), y(line.value(item)), 2.5, 0, Math.PI * 2);
        context.fill();
      }
    }
  }
}

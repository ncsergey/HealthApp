import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
export const DEFAULT_CHANGE_MARKDOWN = "## Изменения\n1. Исправления ошибок.\n2. Оптимизиация приложения.\n";

export function incrementPatchVersion(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new Error("Версия должна иметь формат X.Y.Z.");
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch)) throw new Error("Номер сборки слишком велик.");
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

export function formatBuildDate(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Некорректная дата сборки.");
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${pad(date.getFullYear() % 100)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function updateServiceWorkerCacheName(source, revision) {
  const pattern = /const CACHE_NAME = "health-app-static-[^"]+";/;
  if (!pattern.test(source)) throw new Error("В sw.js не найдена ревизия статического кеша.");
  return source.replace(pattern, `const CACHE_NAME = "health-app-static-${revision}";`);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(" ")} завершилась с кодом ${code}.`)));
  });
}

async function verify(root) {
  if (process.platform === "win32") {
    const commandInterpreter = process.env.ComSpec || "cmd.exe";
    await run(commandInterpreter, ["/d", "/s", "/c", "npm test"], root);
    await run(commandInterpreter, ["/d", "/s", "/c", "npm run check"], root);
    return;
  }
  await run("npm", ["test"], root);
  await run("npm", ["run", "check"], root);
}

export async function buildApplication(root = projectRoot, now = null, verifyBuild = verify) {
  const appInfoPath = resolve(root, "app-info.json");
  const changePath = resolve(root, "CHANGE.md");
  const serviceWorkerPath = resolve(root, "sw.js");
  const [originalAppInfo, originalChange, originalServiceWorker] = await Promise.all([
    readFile(appInfoPath, "utf8"),
    readFile(changePath, "utf8"),
    readFile(serviceWorkerPath, "utf8")
  ]);
  const current = JSON.parse(originalAppInfo);
  if (current.change !== 0 && current.change !== 1) throw new Error("Поле change должно содержать 0 или 1.");
  const nextVersion = incrementPatchVersion(current.version);

  await verifyBuild(root);

  const metadata = { version: nextVersion, buildDate: formatBuildDate(now || new Date()), change: current.change };
  const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
  const nextChange = current.change === 1 ? DEFAULT_CHANGE_MARKDOWN : originalChange;
  const revision = createHash("sha256").update(serialized).update(nextChange).digest("hex").slice(0, 12);
  const nextServiceWorker = updateServiceWorkerCacheName(originalServiceWorker, revision);
  try {
    await writeFile(appInfoPath, serialized, "utf8");
    if (current.change === 1) await writeFile(changePath, nextChange, "utf8");
    await writeFile(serviceWorkerPath, nextServiceWorker, "utf8");
  } catch (error) {
    await Promise.allSettled([
      writeFile(appInfoPath, originalAppInfo, "utf8"),
      ...(current.change === 1 ? [writeFile(changePath, originalChange, "utf8")] : []),
      writeFile(serviceWorkerPath, originalServiceWorker, "utf8")
    ]);
    throw error;
  }
  return { metadata, revision };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { metadata, revision } = await buildApplication();
  console.log(`Сборка ${metadata.version} · ${metadata.buildDate} · кеш ${revision}`);
}

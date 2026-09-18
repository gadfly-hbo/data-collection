/** 极简 .env 加载器：KEY=VALUE 注入 process.env（已存在的环境变量优先）。
 *  凭证只允许经环境变量/.env 进入程序（AGENTS.md 硬性规则）。 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 默认锚定仓库根的 .env（脚本从任意 cwd 直跑都能加载到） */
const REPO_ROOT = resolve(import.meta.dirname, "..");

export function loadDotenv(path: string = resolve(REPO_ROOT, ".env")): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** 一次性迁移：sources.yaml → sources 表（幂等，UNIQUE url 冲突即更新）。 */
import { resolve } from "node:path";

import { loadSourcesYaml } from "../src/config.ts";
import { Database } from "../src/storage/db.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export function importYamlSources(db: Database, yamlPath: string): number {
  let count = 0;
  for (const src of loadSourcesYaml(yamlPath)) {
    db.upsertSource({
      url: src.url,
      schemaType: src.schema_type,
      name: src.name ?? null,
      intervalS: src.interval_s ?? 3600,
      enabled: src.enabled ?? true,
      useBrowser: src.use_browser ?? false,
      instruction: src.instruction ?? "",
    });
    count += 1;
  }
  return count;
}

function main(): number {
  const sourcesIdx = process.argv.indexOf("--sources");
  const yamlPath =
    sourcesIdx !== -1 ? resolve(REPO_ROOT, process.argv[sourcesIdx + 1]) : resolve(REPO_ROOT, "config/sources.yaml");
  const db = new Database(resolve(REPO_ROOT, "data/collector.db"));
  try {
    const count = importYamlSources(db, yamlPath);
    const total = (db.conn.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n;
    console.log(`已导入 ${count} 个来源；sources 表现有 ${total} 条`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}

/** 去重闸门：URL + 内容哈希 + Schema 联合判断，位于快照之后、LLM 调用之前。
 *  命中条件：同 URL、同快照哈希、同 Schema、且此前存在一次成功提取。 */
import { RunStatus } from "./status.ts";
import type { Database } from "./storage/db.ts";

export class DedupGate {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  seen(url: string, rawHash: string, schemaType: string): boolean {
    const row = this.db.conn
      .prepare(
        `SELECT 1 FROM crawl_runs cr
         JOIN extracted_items ei ON ei.run_id = cr.id
         WHERE cr.url = ? AND cr.raw_hash = ? AND cr.status = ? AND ei.schema_type = ?
         LIMIT 1`,
      )
      .get(url, rawHash, RunStatus.SUCCESS, schemaType);
    return row !== undefined;
  }
}

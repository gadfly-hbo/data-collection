/** 原始快照存储：SHA-256 内容哈希寻址，防篡改、同内容天然去重。 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class RawStore {
  readonly root: string;

  constructor(root: string = "data/raw") {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  static contentHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  /** 写入快照并返回内容哈希；tmp + rename 原子落盘，同内容幂等。 */
  save(content: string): string {
    const digest = RawStore.contentHash(content);
    const path = this.path(digest);
    if (!existsSync(path)) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, path);
    }
    return digest;
  }

  path(contentHash: string): string {
    return join(this.root, `${contentHash}.md`);
  }

  exists(contentHash: string): boolean {
    return existsSync(this.path(contentHash));
  }

  read(contentHash: string): string {
    return readFileSync(this.path(contentHash), "utf8");
  }
}

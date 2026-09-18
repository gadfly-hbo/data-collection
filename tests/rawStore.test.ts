import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RawStore } from "../src/storage/rawStore.ts";

describe("storage/rawStore", () => {
  it("哈希寻址：文件名=哈希、读写一致、同内容幂等单文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-raw-"));
    const store = new RawStore(join(dir, "raw"));
    const d1 = store.save("中文快照 ✓");
    const d2 = store.save("中文快照 ✓");
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    expect(store.read(d1)).toBe("中文快照 ✓");
    store.save("另一份内容");
    const files = readdirSync(join(dir, "raw")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("不残留 .tmp 文件（原子写盘）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-raw2-"));
    const store = new RawStore(join(dir, "raw"));
    store.save("内容");
    const files = readdirSync(join(dir, "raw"));
    expect(files.filter((f) => f.endsWith(".tmp")).length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

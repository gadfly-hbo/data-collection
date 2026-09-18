import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DedupGate } from "../src/dedup.ts";
import { Fetcher } from "../src/fetcher.ts";
import { NewsItem } from "../src/models/schemas.ts";
import { Pipeline, isOkOutcome } from "../src/pipeline.ts";
import { UsageReportedError } from "../src/providers/base.ts";
import { TransientProviderError } from "../src/providers/base.ts";
import { RunStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";
import { RunLedger } from "../src/storage/ledger.ts";
import { RawStore } from "../src/storage/rawStore.ts";
import { FakeProvider, fakeResult, sendHtml, sendText, validNewsItem, withServer } from "./helpers.ts";

const ARTICLE = readFileSync(join(import.meta.dirname, "fixtures", "article.html"), "utf8");
const LINK_LIST = readFileSync(join(import.meta.dirname, "fixtures", "link_list.html"), "utf8");

function tmp() {
  return mkdtempSync(join(tmpdir(), "dc-pipe-"));
}

describe("pipeline 主干", () => {
  it("成功路径：fetch→parse→extract→台账，追溯字段系统覆盖", async () => {
    const dir = tmp();
    const db = new Database(":memory:");
    const provider = new FakeProvider([fakeResult(validNewsItem())]);
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      sendHtml(res, ARTICLE);
    }, async (base) => {
      const fetcher = new Fetcher("TestBot/1.0", 0);
      const pipeline = new Pipeline(fetcher, provider, new RawStore(join(dir, "raw")),
        new DedupGate(db), new RunLedger(db));
      const outcome = await pipeline.run({ url: `${base}/news/1`, schema: NewsItem });
      expect(outcome.status).toBe(RunStatus.SUCCESS);
      const item = outcome.item as Record<string, unknown>;
      expect(item.source_url).toBe(`${base}/news/1`); // 系统覆盖
      expect(item.scraped_at).toBeTruthy();
      expect(outcome.rawHash).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.runId).toBeGreaterThan(0);
      expect(provider.calls.length).toBe(1);
      const run = db.conn.prepare("SELECT * FROM crawl_runs WHERE id = ?").get(outcome.runId!) as Record<string, unknown>;
      expect(run.status).toBe("SUCCESS");
      expect(run.provider).toBe("fake");
      const itemRow = db.conn.prepare("SELECT * FROM extracted_items").all();
      expect(itemRow.length).toBe(1);
      await fetcher.close();
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("过闸门失败不消耗 LLM：BLOCKED / FETCH_ERROR / 无正文", async () => {
    const db = new Database(":memory:");
    const provider = new FakeProvider([fakeResult(validNewsItem())]);
    // BLOCKED：robots 拒绝
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 200, "User-agent: *\nDisallow: /\n");
      sendHtml(res, ARTICLE);
    }, async (base) => {
      const f = new Fetcher("T/1.0", 0);
      const p = new Pipeline(f, provider);
      const o = await p.run({ url: `${base}/x`, schema: NewsItem });
      expect(o.status).toBe(RunStatus.BLOCKED);
      await f.close();
    });
    // FETCH_ERROR：页面 500
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      sendText(res, 500, "boom");
    }, async (base) => {
      const f = new Fetcher("T/1.0", 0);
      const p = new Pipeline(f, provider);
      const o = await p.run({ url: `${base}/x`, schema: NewsItem });
      expect(o.status).toBe(RunStatus.FETCH_ERROR);
      await f.close();
    });
    // SKIPPED_NO_CONTENT：列表页
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      sendHtml(res, LINK_LIST);
    }, async (base) => {
      const f = new Fetcher("T/1.0", 0);
      const p = new Pipeline(f, provider, new RawStore(join(tmp(), "raw")), new DedupGate(db));
      const o = await p.run({ url: `${base}/list`, schema: NewsItem });
      expect(o.status).toBe(RunStatus.SKIPPED_NO_CONTENT);
      await f.close();
    });
    expect(provider.calls.length).toBe(0); // 全程 0 次 LLM 调用
    db.close();
  });

  it("重复执行同一 URL：第二次 SKIPPED_UNCHANGED 且 0 次重复 LLM 调用", async () => {
    const dir = tmp();
    const db = new Database(":memory:");
    const provider = new FakeProvider([fakeResult(validNewsItem())]);
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      sendHtml(res, ARTICLE);
    }, async (base) => {
      const fetcher = new Fetcher("T/1.0", 0);
      const pipeline = new Pipeline(fetcher, provider, new RawStore(join(dir, "raw")),
        new DedupGate(db), new RunLedger(db));
      const task = { url: `${base}/story`, schema: NewsItem };
      const first = await pipeline.run(task);
      const second = await pipeline.run(task);
      expect(first.status).toBe(RunStatus.SUCCESS);
      expect(second.status).toBe(RunStatus.SKIPPED_UNCHANGED);
      expect(second.rawHash).toBe(first.rawHash);
      expect(provider.calls.length).toBe(1);
      await fetcher.close();
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("校验失败全新重试一次（附失败原因）；两次失败记 SCHEMA_ERROR 且携带用量", async () => {
    const dir = tmp();
    const db = new Database(":memory:");
    const provider = new FakeProvider([
      new UsageReportedError("bad", 50, 5),
      new UsageReportedError("still bad", 30, 4),
    ]);
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      sendHtml(res, ARTICLE);
    }, async (base) => {
      const fetcher = new Fetcher("T/1.0", 0);
      const pipeline = new Pipeline(fetcher, provider, new RawStore(join(dir, "raw")),
        new DedupGate(db), new RunLedger(db));
      const outcome = await pipeline.run({ url: `${base}/story`, schema: NewsItem });
      expect(outcome.status).toBe(RunStatus.SCHEMA_ERROR);
      expect(outcome.inputTokens).toBe(80); // 两次累计
      expect(outcome.outputTokens).toBe(9);
      expect(provider.calls.length).toBe(2);
      expect(provider.calls[1].instruction).toContain("未通过");
      const run = db.conn.prepare("SELECT input_tokens, status FROM crawl_runs").get() as { input_tokens: number; status: string };
      expect(run.status).toBe("SCHEMA_ERROR");
      expect(run.input_tokens).toBe(80);
      await fetcher.close();
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("供应商异常兑换 FETCH_ERROR 终态并入台账（不绕过 crawl_runs）", async () => {
    const db = new Database(":memory:");
    const provider = new FakeProvider([new TransientProviderError("429 quota")]);
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      sendHtml(res, ARTICLE);
    }, async (base) => {
      const fetcher = new Fetcher("T/1.0", 0);
      const pipeline = new Pipeline(fetcher, provider, undefined, undefined, new RunLedger(db));
      const outcome = await pipeline.run({ url: `${base}/story`, schema: NewsItem });
      expect(outcome.status).toBe(RunStatus.FETCH_ERROR);
      expect(outcome.error).toContain("TransientProviderError");
      const run = db.conn.prepare("SELECT * FROM crawl_runs").get() as Record<string, unknown>;
      expect(run.status).toBe("FETCH_ERROR");
      expect(String(run.error_msg)).toContain("TransientProviderError");
      await fetcher.close();
    });
    db.close();
  });

  it("提取失败后内容未变：下次全量重抓重试，不被 304 短路", async () => {
    const dir = tmp();
    const db = new Database(":memory:");
    let pageHits = 0;
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      pageHits++;
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304);
        return res.end();
      }
      sendHtml(res, ARTICLE, { ETag: '"v1"' });
    }, async (base) => {
      const fetcher = new Fetcher("T/1.0", 0);
      const task = { url: `${base}/story`, schema: NewsItem };
      const bad = new Pipeline(fetcher,
        new FakeProvider([new UsageReportedError("bad json", 10, 2)]),
        new RawStore(join(dir, "raw")), new DedupGate(db), new RunLedger(db));
      expect((await bad.run(task)).status).toBe(RunStatus.SCHEMA_ERROR);
      expect(pageHits).toBe(1);

      const good = new Pipeline(fetcher,
        new FakeProvider([fakeResult(validNewsItem())]),
        new RawStore(join(dir, "raw")), new DedupGate(db), new RunLedger(db));
      const outcome = await good.run(task);
      expect(outcome.status).toBe(RunStatus.SUCCESS);
      expect(pageHits).toBe(2); // 未被 304 短路
      const again = await good.run(task);
      expect(again.status).toBe(RunStatus.SKIPPED_UNCHANGED); // 成功后 304 短路恢复
      expect(pageHits).toBe(3);
      await fetcher.close();
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("isOkOutcome：SKIP_* 属按设计跳过", () => {
    expect(isOkOutcome(RunStatus.SUCCESS)).toBe(true);
    expect(isOkOutcome(RunStatus.SKIPPED_UNCHANGED)).toBe(true);
    expect(isOkOutcome(RunStatus.FETCH_ERROR)).toBe(false);
  });
});

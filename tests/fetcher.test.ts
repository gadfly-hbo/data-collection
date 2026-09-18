import { describe, expect, it } from "vitest";

import { Fetcher, FetchStatus } from "../src/fetcher.ts";
import { sendHtml, sendText, withServer } from "./helpers.ts";

const UA = "TestBot/1.0";

describe("fetcher", () => {
  it("robots 允许 → 抓取成功带 HTML", async () => {
    await withServer(
      (req, res) => {
        if (req.url === "/robots.txt") return sendText(res, 200, "User-agent: *\nDisallow:\n");
        sendHtml(res, "<html><body>hello</body></html>");
      },
      async (base) => {
        const f = new Fetcher(UA, 0);
        const r = await f.fetch(`${base}/page`);
        expect(r.status).toBe(FetchStatus.OK);
        expect(r.html).toContain("hello");
        await f.close();
      },
    );
  });

  it("robots 拒绝 → BLOCKED 且不发页面请求", async () => {
    let pageHits = 0;
    await withServer(
      (req, res) => {
        if (req.url === "/robots.txt") return sendText(res, 200, "User-agent: *\nDisallow: /\n");
        pageHits++;
        sendHtml(res, "x");
      },
      async (base) => {
        const f = new Fetcher(UA, 0);
        const r = await f.fetch(`${base}/post`);
        expect(r.status).toBe(FetchStatus.BLOCKED);
        expect(r.reason).toContain("robots");
        expect(pageHits).toBe(0);
        await f.close();
      },
    );
  });

  it("robots 404 → 允许；robots 5xx → 全站禁止；robots 网络异常 → FETCH_ERROR", async () => {
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "not found");
      sendHtml(res, "ok");
    }, async (base) => {
      const f = new Fetcher(UA, 0);
      const r = await f.fetch(`${base}/p`);
      expect(r.status).toBe(FetchStatus.OK);
      await f.close();
    });
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 503, "busy");
      sendHtml(res, "should-not-happen");
    }, async (base) => {
      const f = new Fetcher(UA, 0);
      const r = await f.fetch(`${base}/p`);
      expect(r.status).toBe(FetchStatus.BLOCKED);
      await f.close();
    });
    // 网络异常：服务器直接拒绝连接
    const f = new Fetcher(UA, 0);
    const r = await f.fetch("http://127.0.0.1:1/nope");
    expect(r.status).toBe(FetchStatus.FETCH_ERROR);
    expect(r.reason).toContain("robots");
    await f.close();
  });

  it("状态分类：401/403/429 → BLOCKED；5xx/404 → FETCH_ERROR", async () => {
    for (const [code, expected] of [
      [403, FetchStatus.BLOCKED],
      [429, FetchStatus.BLOCKED],
      [500, FetchStatus.FETCH_ERROR],
      [404, FetchStatus.FETCH_ERROR],
    ] as const) {
      await withServer((req, res) => {
        if (req.url === "/robots.txt") return sendText(res, 404, "");
        sendText(res, code, "");
      }, async (base) => {
        const f = new Fetcher(UA, 0);
        const r = await f.fetch(`${base}/doc${code}`);
        expect(r.status).toBe(expected);
        await f.close();
      });
    }
  });

  it("条件请求 304 短路；discardValidators 后全量重抓", async () => {
    let pageHits = 0;
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      pageHits++;
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304);
        return res.end();
      }
      sendHtml(res, "<html>v1</html>", { ETag: '"v1"' });
    }, async (base) => {
      const f = new Fetcher(UA, 0);
      const first = await f.fetch(`${base}/doc`);
      expect(first.status).toBe(FetchStatus.OK);
      const second = await f.fetch(`${base}/doc`);
      expect(second.notModified).toBe(true);
      expect(second.html).toBeUndefined();
      f.discardValidators(`${base}/doc`);
      const third = await f.fetch(`${base}/doc`);
      expect(third.notModified).toBeFalsy();
      expect(third.html).toContain("v1");
      expect(pageHits).toBe(3);
      await f.close();
    });
  });

  it("非法 URL 返回 FETCH_ERROR（契约，不抛异常）", async () => {
    const f = new Fetcher(UA, 0);
    for (const bad of ["http://", "not-a-url", "https://[::1"]) {
      const r = await f.fetch(bad);
      expect(r.status).toBe(FetchStatus.FETCH_ERROR);
      expect(r.reason).toContain("URL");
    }
    await f.close();
  });

  it("同域名最小间隔限速生效", async () => {
    await withServer((req, res) => {
      if (req.url === "/robots.txt") return sendText(res, 404, "");
      sendText(res, 200, "ok");
    }, async (base) => {
      const f = new Fetcher(UA, 0.15);
      const t0 = Date.now();
      await f.fetch(`${base}/1`);
      await f.fetch(`${base}/2`);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(140); // 第二次请求被垫到 ≥ 间隔
      await f.close();
    });
  });
});

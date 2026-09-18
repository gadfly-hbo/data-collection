/** 抓取器：fetch 拉取 + robots 合规 + 同域限速 + 条件请求；可选 Playwright 浏览器渲染。
 *  对目标站点的所有 HTTP 请求必须经由本模块（AGENTS.md 硬性规则）。 */
import robotsParserModule from "robots-parser";

/** robots-parser 为 CJS 默认导出函数；此处显式收窄为可调用签名。 */
interface Robots {
  isDisallowed(url: string, userAgent?: string): boolean | undefined;
}
const robotsParser = robotsParserModule as unknown as (url: string, text: string) => Robots;

export const FetchStatus = {
  OK: "OK",
  BLOCKED: "BLOCKED",
  FETCH_ERROR: "FETCH_ERROR",
} as const;
export type FetchStatus = (typeof FetchStatus)[keyof typeof FetchStatus];

export interface FetchResult {
  status: FetchStatus;
  url: string;
  html?: string;
  statusCode?: number;
  /** 304 短路：内容未变，pipeline 据此映射为 SKIPPED_UNCHANGED */
  notModified?: boolean;
  reason?: string;
}

const BLOCKED_CODES = new Set([401, 403, 429]);
const BROWSER_TIMEOUT_MS = 30_000;

type RobotsTxt = Robots | null;

export class Fetcher {
  private robotsCache = new Map<string, RobotsTxt>();
  private lastHit = new Map<string, number>();
  private locks = new Map<string, Promise<void>>();
  /** url → 已确认的条件请求验证器（仅成功任务保留；失败后被 discard） */
  private validators = new Map<string, { etag?: string; lastModified?: string }>();
  private browser: import("playwright").Browser | null = null;
  private page: import("playwright").Page | null = null;

  readonly userAgent: string;
  readonly minIntervalPerHostS: number;
  readonly respectRobots: boolean;
  readonly timeoutS: number;

  constructor(
    userAgent: string,
    minIntervalPerHostS = 5,
    respectRobots = true,
    timeoutS = 30,
  ) {
    this.userAgent = userAgent;
    this.minIntervalPerHostS = minIntervalPerHostS;
    this.respectRobots = respectRobots;
    this.timeoutS = timeoutS;
  }

  async fetch(url: string, opts: { useBrowser?: boolean } = {}): Promise<FetchResult> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch (e) {
      return { status: FetchStatus.FETCH_ERROR, url, reason: `非法 URL: ${e}` };
    }
    if (!host) {
      return { status: FetchStatus.FETCH_ERROR, url, reason: "非法 URL: 缺少 host" };
    }

    if (this.respectRobots) {
      const robots = await this.robotsFor(url);
      if (robots instanceof Error) {
        return { status: FetchStatus.FETCH_ERROR, url, reason: `robots.txt 不可达: ${robots.message}` };
      }
      if (robots && robots.isDisallowed(url, this.userAgent)) {
        return { status: FetchStatus.BLOCKED, url, reason: "robots.txt disallow" };
      }
    }

    await this.pace(host);

    if (opts.useBrowser) return this.fetchWithBrowser(url);

    const headers: Record<string, string> = { "User-Agent": this.userAgent };
    const v = this.validators.get(url);
    if (v?.etag) headers["If-None-Match"] = v.etag;
    if (v?.lastModified) headers["If-Modified-Since"] = v.lastModified;

    try {
      const resp = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutS * 1000),
      });
      if (resp.status === 304) {
        return { status: FetchStatus.OK, url, statusCode: 304, notModified: true };
      }
      if (BLOCKED_CODES.has(resp.status)) {
        return { status: FetchStatus.BLOCKED, url, statusCode: resp.status,
                 reason: `目标站拒绝访问（${resp.status}）` };
      }
      if (resp.status >= 400) {
        return { status: FetchStatus.FETCH_ERROR, url, statusCode: resp.status,
                 reason: `HTTP ${resp.status}` };
      }
      const html = await resp.text();
      this.validators.set(url, {
        etag: resp.headers.get("etag") ?? undefined,
        lastModified: resp.headers.get("last-modified") ?? undefined,
      });
      return { status: FetchStatus.OK, url: resp.url, html, statusCode: resp.status };
    } catch (e) {
      return { status: FetchStatus.FETCH_ERROR, url, reason: String(e) };
    }
  }

  /** 任务失败后丢弃条件请求验证器：下次全量重抓，防止 304 短路吞掉失败重试 */
  discardValidators(url: string): void {
    this.validators.delete(url);
  }

  /** robots.txt 按域名加载并缓存；返回 RobotsTxt | null（无声明=允许）| Error（不可达） */
  private async robotsFor(url: string): Promise<RobotsTxt | Error> {
    const host = new URL(url).host;
    if (this.robotsCache.has(host)) return this.robotsCache.get(host)!;

    const robotsUrl = `${new URL(url).origin}/robots.txt`;
    let resp: Response;
    try {
      resp = await fetch(robotsUrl, {
        headers: { "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutS * 1000),
      });
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e)); // 不缓存，恢复后重试
    }
    let parsed: RobotsTxt;
    if (resp.status >= 500) {
      // RFC 9309：robots 不可达（5xx）期间按全站禁止；不缓存以便恢复后重试
      return robotsParser(robotsUrl, "User-agent: *\nDisallow: /\n");
    } else if (resp.status >= 400) {
      parsed = null; // 404 等：站点未声明 robots，允许
    } else {
      parsed = robotsParser(robotsUrl, await resp.text());
    }
    this.robotsCache.set(host, parsed);
    return parsed;
  }

  /** 同域名请求保持最小间隔（在途串行由单 Worker 结构保证）。 */
  private async pace(host: string): Promise<void> {
    const prev = this.locks.get(host) ?? Promise.resolve();
    const next = (async () => {
      await prev;
      const last = this.lastHit.get(host);
      if (last !== undefined) {
        const remaining = this.minIntervalPerHostS - (Date.now() / 1000 - last);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining * 1000));
      }
      this.lastHit.set(host, Date.now() / 1000);
    })();
    this.locks.set(host, next.catch(() => {}));
    await next;
  }

  // ---------- 浏览器渲染路径（JS 渲染 / SPA 站点，可选） ----------

  private async ensurePage(): Promise<import("playwright").Page> {
    if (this.page) return this.page;
    let playwright: typeof import("playwright");
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error("未安装 playwright：npm i -D playwright && npx playwright install chromium");
    }
    let browser: import("playwright").Browser | null = null;
    try {
      browser = await playwright.chromium.launch({ headless: true });
      this.page = await browser.newPage({ userAgent: this.userAgent });
      this.browser = browser;
      return this.page;
    } catch (e) {
      // 启动失败回滚已启动的资源，避免残留实例泄漏
      try {
        if (browser) await browser.close();
      } catch { /* 忽略 */ }
      this.browser = null;
      this.page = null;
      throw e;
    }
  }

  private async fetchWithBrowser(url: string): Promise<FetchResult> {
    try {
      const page = await this.ensurePage();
      const resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: BROWSER_TIMEOUT_MS,
      });
      const status = resp?.status();
      const html = await page.content();
      if (status !== undefined && BLOCKED_CODES.has(status)) {
        return { status: FetchStatus.BLOCKED, url, statusCode: status,
                 reason: `目标站拒绝访问（${status}）` };
      }
      if (status !== undefined && status >= 400) {
        return { status: FetchStatus.FETCH_ERROR, url, statusCode: status,
                 reason: `HTTP ${status}` };
      }
      return { status: FetchStatus.OK, url, html, statusCode: status };
    } catch (e) {
      return { status: FetchStatus.FETCH_ERROR, url, reason: String(e) };
    }
  }

  async close(): Promise<void> {
    try {
      if (this.page) await this.page.close();
      if (this.browser) await this.browser.close();
    } catch { /* 忽略 */ }
    this.page = null;
    this.browser = null;
  }
}

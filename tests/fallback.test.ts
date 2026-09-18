import { describe, expect, it } from "vitest";

import { NewsItem } from "../src/models/schemas.ts";
import { FallbackProvider, RateLimitedProvider } from "../src/providers/factory.ts";
import { TransientProviderError } from "../src/providers/base.ts";
import { fakeResult, validNewsItem, FakeProvider } from "./helpers.ts";

const noSleep = async () => {};

describe("providers：降级与限速栈", () => {
  it("主退避穷尽 → fallback 完成，onDegrade 触发", async () => {
    const degraded: [string, string][] = [];
    const primary = new FakeProvider([new TransientProviderError("429")], "primary-fake");
    const fallback = new FakeProvider([fakeResult(validNewsItem(), "fallback-fake")], "fallback-fake");
    const stack = new FallbackProvider(primary, fallback, 2,
      (a, b) => degraded.push([a, b]), noSleep);

    const result = await stack.extract("正文", NewsItem);
    expect(result.provider).toBe("fallback-fake");
    expect(primary.calls.length).toBe(3); // 首次 + 2 次退避重试
    expect(fallback.calls.length).toBe(1);
    expect(degraded).toEqual([["primary-fake", "fallback-fake"]]);
  });

  it("双供应商都穷尽 → 抛出；无 fallback → 主穷尽直接抛", async () => {
    const p1 = new FakeProvider([new TransientProviderError("429")], "p1");
    const p2 = new FakeProvider([new TransientProviderError("503")], "p2");
    await expect(
      new FallbackProvider(p1, p2, 1, undefined, noSleep).extract("x", NewsItem),
    ).rejects.toThrow(TransientProviderError);
    expect(p1.calls.length).toBe(2);
    expect(p2.calls.length).toBe(2);

    const solo = new FakeProvider([new TransientProviderError("429")], "solo");
    await expect(
      new FallbackProvider(solo, null, 1, undefined, noSleep).extract("x", NewsItem),
    ).rejects.toThrow(TransientProviderError);
    expect(solo.calls.length).toBe(2);
  });

  it("RateLimitedProvider：先限速后调用", async () => {
    const acquired: boolean[] = [];
    const inner = new FakeProvider([fakeResult(validNewsItem())]);
    const provider = new RateLimitedProvider(inner, 60);
    // 替换内部 limiter 为探针
    (provider as unknown as { limiter: { acquire(): Promise<void> } }).limiter = {
      acquire: async () => {
        acquired.push(true);
      },
    };
    await provider.extract("内容", NewsItem);
    expect(acquired).toEqual([true]);
  });
});

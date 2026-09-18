import { describe, expect, it } from "vitest";

import { TokenBucketLimiter, withBackoff } from "../src/rateLimiter.ts";
import { TransientProviderError } from "../src/providers/base.ts";

class Sleeper {
  waits: number[] = [];
  async call(seconds: number): Promise<void> {
    this.waits.push(seconds);
  }
}

const sleepOf = (s: Sleeper) => (sec: number) => s.call(sec);

describe("rateLimiter：指数退避", () => {
  it("429 序列退避间隔 2s→4s→8s→16s→32s，穷尽上抛", async () => {
    const sleeper = new Sleeper();
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls <= 5) throw new TransientProviderError("429 quota");
      return "ok";
    };
    const result = await withBackoff(flaky, {
      sleep: sleepOf(sleeper),
      rng: () => 0,
      isTransient: (e) => e instanceof TransientProviderError,
    });
    expect(result).toBe("ok");
    expect(calls).toBe(6); // 首次 + 5 次重试
    expect(sleeper.waits.map(Math.round)).toEqual([2, 4, 8, 16, 32]);
  });

  it("穷尽后向上抛出；非瞬态错误立即传播", async () => {
    const sleeper = new Sleeper();
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw new TransientProviderError("429");
        },
        { maxRetries: 2, sleep: sleepOf(sleeper), rng: () => 0,
          isTransient: (e) => e instanceof TransientProviderError },
      ),
    ).rejects.toThrow(TransientProviderError);
    expect(calls).toBe(3); // 首次 + 2 次重试

    await expect(
      withBackoff(async () => {
        throw new Error("API key not valid");
      }, { sleep: sleepOf(sleeper), isTransient: () => false }),
    ).rejects.toThrow("not valid");
  });

  it("抖动只增不减", async () => {
    const sleeper = new Sleeper();
    await expect(
      withBackoff(async () => {
        throw new TransientProviderError("503");
      }, { maxRetries: 1, sleep: sleepOf(sleeper), rng: () => 1 }),
    ).rejects.toThrow();
    expect(sleeper.waits[0]).toBeCloseTo(2.5); // 2 × (1 + 0.25×1)
  });
});

describe("rateLimiter：令牌桶", () => {
  it("超过速率的调用被延迟而非立即发出", async () => {
    let now = 100;
    const waits: number[] = [];
    const limiter = new TokenBucketLimiter(
      6, // 0.1 token/s
      1,
      () => now,
      async (s) => {
        waits.push(s);
        now += s;
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits[0]).toBeCloseTo(10);
    expect(waits[1]).toBeCloseTo(10);
  });

  it("非法 rpm 拒绝", () => {
    expect(() => new TokenBucketLimiter(0)).toThrow(/rpm/);
  });
});

/** 限流退避：429/5xx 指数退避 + 抖动；按 RPM 的令牌桶主动限速。 */

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY = 2.0;
const DEFAULT_CAP = 300.0;
const DEFAULT_JITTER = 0.25;

export interface BackoffOptions {
  maxRetries?: number;
  baseDelay?: number;
  cap?: number;
  jitter?: number;
  rng?: () => number;
  sleep?: (seconds: number) => Promise<void>;
  isTransient?: (err: unknown) => boolean;
}

const defaultSleep = (seconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

/** 执行 fn；瞬态错误按 2s→4s→8s→16s→32s（封顶 cap）退避重试，穷尽上抛。 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts.baseDelay ?? DEFAULT_BASE_DELAY;
  const cap = opts.cap ?? DEFAULT_CAP;
  const jitter = opts.jitter ?? DEFAULT_JITTER;
  const rng = opts.rng ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const isTransient = opts.isTransient ?? (() => true);

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= maxRetries) throw err;
      const delay = Math.min(cap, baseDelay * 2 ** attempt) * (1 + jitter * rng());
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** 令牌桶：超过 RPM 速率的调用等待而非发出（主动限速，从源头避免 429）。 */
export class TokenBucketLimiter {
  private tokens: number;
  private updated: number;
  readonly rate: number;
  readonly capacity: number;
  private readonly clock: () => number;
  private readonly sleep: (seconds: number) => Promise<void>;

  constructor(
    rpm: number,
    burst?: number,
    clock: () => number = () => Date.now() / 1000,
    sleep: (seconds: number) => Promise<void> = defaultSleep,
  ) {
    this.clock = clock;
    this.sleep = sleep;
    if (rpm <= 0) throw new Error("rpm 必须为正数");
    this.rate = rpm / 60;
    this.capacity = burst ?? Math.max(1, rpm / 2);
    this.tokens = this.capacity;
    this.updated = this.clock();
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock();
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.updated) * this.rate);
      this.updated = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep((1 - this.tokens) / this.rate);
    }
  }
}

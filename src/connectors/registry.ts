/** Connector 注册表：定制数据采集的声明式数据源（零 LLM 成本路径）。
 *  每个 connector = id + 参数 zod + 抓取实现（统一走 Fetcher：合规限速）；
 *  产出时序行交 CustomExecutor 写 artifacts(kind=dataset)。 */
import { z, type ZodType } from "zod";

import type { Fetcher } from "../fetcher.ts";

export interface DatasetRow {
  /** 行时间戳（ISO），用于跨运行去重水位 */
  ts: string;
  values: Record<string, number | string | null>;
}

export interface ConnectorDeps {
  fetcher: Fetcher;
}

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly params: ZodType;
  /** 建议最小调度间隔（秒） */
  readonly minIntervalS: number;
  /** true = 官方 API 数据源（Fetcher 走 api 通道：保留限速、跳过 robots） */
  readonly api?: boolean;
  fetchRows(params: unknown, deps: ConnectorDeps): Promise<DatasetRow[]>;
}

export class WeatherConnector implements Connector {
  readonly id = "weather";
  readonly name = "天气数据";
  readonly description = "open-meteo 免费接口（无需 Key）：温度 / 降水 / 风速逐小时时序";
  readonly minIntervalS = 3600;
  readonly api = true;
  readonly params = z.object({
    city: z.enum(["深圳", "上海", "北京", "广州", "杭州"]),
  });

  private static readonly COORDS: Record<string, [number, number]> = {
    深圳: [22.54, 114.06], 上海: [31.23, 121.47], 北京: [39.9, 116.4],
    广州: [23.13, 113.26], 杭州: [30.27, 120.15],
  };

  async fetchRows(rawParams: unknown, deps: ConnectorDeps): Promise<DatasetRow[]> {
    const { city } = this.params.parse(rawParams) as { city: string };
    const [lat, lon] = WeatherConnector.COORDS[city] ?? [22.54, 114.06];
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,precipitation,wind_speed_10m&past_days=1&forecast_days=1`;
    const resp = await deps.fetcher.fetch(url, { api: this.api });
    if (resp.status !== "OK" || !resp.html) {
      throw new Error(`天气接口抓取失败：${resp.reason ?? `HTTP ${resp.statusCode}`}`);
    }
    const data = JSON.parse(resp.html) as {
      hourly?: { time?: string[]; temperature_2m?: (number | null)[];
                 precipitation?: (number | null)[]; wind_speed_10m?: (number | null)[] };
    };
    const h = data.hourly;
    if (!h?.time) throw new Error("天气接口响应缺少 hourly.time");
    return h.time.map((ts, i) => ({
      ts,
      values: {
        temperature_2m: h.temperature_2m?.[i] ?? null,
        precipitation: h.precipitation?.[i] ?? null,
        wind_speed_10m: h.wind_speed_10m?.[i] ?? null,
      },
    }));
  }
}

export const CONNECTOR_REGISTRY: Record<string, Connector> = {
  weather: new WeatherConnector(),
};

export function getConnector(id: string): Connector {
  const c = CONNECTOR_REGISTRY[id];
  if (!c) throw new Error(`未知 connector: ${id}（可用：${Object.keys(CONNECTOR_REGISTRY).join(", ")}）`);
  return c;
}

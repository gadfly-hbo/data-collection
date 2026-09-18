/** 配置加载：settings.yaml + sources.yaml。 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Settings {
  provider: {
    primary?: string;
    fallback?: string;
    [key: string]: unknown;
  };
  budget?: { max_tasks_per_day: number; max_input_tokens_per_day: number };
  scheduler?: { tick_s?: number };
  alerts?: { macos_notify?: boolean };
  fetch?: {
    user_agent?: string;
    min_interval_per_host_s?: number;
    respect_robots?: boolean;
  };
}

export function loadSettings(path: string = "config/settings.yaml"): Settings {
  return parse(readFileSync(path, "utf8")) as Settings;
}

export interface SourceYaml {
  name?: string;
  url: string;
  schema_type: string;
  interval_s?: number;
  enabled?: boolean;
  use_browser?: boolean;
  instruction?: string;
}

export function loadSourcesYaml(path: string = "config/sources.yaml"): SourceYaml[] {
  const data = (parse(readFileSync(path, "utf8")) ?? {}) as { sources?: SourceYaml[] };
  return data.sources ?? [];
}

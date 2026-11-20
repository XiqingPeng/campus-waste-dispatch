export const modelChoices = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义千问（Qwen）' },
  { value: 'openai', label: 'OpenAI' },
] as const;
export type ModelApi = 'none' | (typeof modelChoices)[number]['value'];
export type ApiSettings = { statsModel: ModelApi; adviceModel: ModelApi };
export const defaultSettings: ApiSettings = {
  statsModel: 'none',
  adviceModel: 'none',
};
// Reuse the storage key so legacy URLs are replaced by model selections.
export const settingsKey = 'campus-loop.collection-apis.v1';
function model(value: unknown): ModelApi {
  return modelChoices.some((item) => item.value === value)
    ? (value as ModelApi)
    : 'none';
}
export function restoreSettings(value: string | null): ApiSettings {
  try {
    const raw = JSON.parse(value ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { ...defaultSettings };
    return {
      statsModel: model(raw.statsModel),
      adviceModel: model(
        raw.adviceModel ??
          (raw.adviceMode === 'deepseek' ? 'deepseek' : 'none'),
      ),
    };
  } catch {
    return { ...defaultSettings };
  }
}
export function supportsAdvice(model: ModelApi) {
  return model === 'none' || model === 'deepseek';
}
export type ZoneStat = {
  name: string;
  bin_count: number | null;
  events: number;
};
export type Statistics = {
  total: number;
  resolved: number | null;
  average: number | null;
  hourly: number[];
  zones: ZoneStat[];
  start: number;
  end: number;
  days: number;
  source: string;
  rules: { action: string; evidence: string }[];
};
export type Advice = {
  summary: string;
  suggestions: { action: string; basis: string; limitation: string }[];
  generatedAt: number;
  source: string;
  start: number;
  end: number;
  days: number;
  note?: string;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('接口返回格式不正确。');
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('统计数量必须是非负整数。');
  return value;
}
export function normalizeStats(
  raw: unknown,
  range: { start: number; end: number; days: number; source: string },
): Statistics {
  const data = object(raw);
  const total = count(data.total);
  if (
    !Array.isArray(data.hourly) ||
    data.hourly.length !== 24 ||
    !Array.isArray(data.zones)
  )
    throw new Error('统计接口需返回 total、hourly[24] 和 zones[]。');
  const hourly = data.hourly.map(count);
  if (hourly.reduce((a, b) => a + b, 0) !== total)
    throw new Error('小时分布合计与总事件数不一致。');
  const zones = data.zones.map((value) => {
    const zone = object(value);
    if (typeof zone.name !== 'string' || !zone.name.trim())
      throw new Error('分区缺少名称。');
    return {
      name: zone.name,
      events: count(zone.events),
      bin_count: zone.bin_count == null ? null : count(zone.bin_count),
    };
  });
  const resolved = data.resolved == null ? null : count(data.resolved);
  if (resolved != null && resolved > total)
    throw new Error('已完成数量不能大于事件总数。');
  const average = data.avg_wait == null ? null : data.avg_wait;
  if (
    average != null &&
    (typeof average !== 'number' || !Number.isFinite(average) || average < 0)
  )
    throw new Error('平均等待时长格式不正确。');
  return {
    total,
    resolved,
    average: average as number | null,
    hourly,
    zones,
    ...range,
    rules: [],
  };
}

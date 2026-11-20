export type ApiSettings = {
  statsMode: 'backend' | 'custom';
  statsUrl: string;
  adviceMode: 'rules' | 'deepseek' | 'custom';
  adviceUrl: string;
};
export const defaultSettings: ApiSettings = {
  statsMode: 'backend',
  statsUrl: '',
  adviceMode: 'rules',
  adviceUrl: '',
};
export const settingsKey = 'campus-loop.collection-apis.v1';
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
export function restoreSettings(value: string | null): ApiSettings {
  try {
    const raw = JSON.parse(value ?? '{}');
    return {
      statsMode: raw.statsMode === 'custom' ? 'custom' : 'backend',
      statsUrl: typeof raw.statsUrl === 'string' ? raw.statsUrl : '',
      adviceMode: ['rules', 'deepseek', 'custom'].includes(raw.adviceMode)
        ? raw.adviceMode
        : 'rules',
      adviceUrl: typeof raw.adviceUrl === 'string' ? raw.adviceUrl : '',
    };
  } catch {
    return { ...defaultSettings };
  }
}
export function endpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('请填写完整的 HTTP(S) 接口地址。');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('接口地址仅支持 HTTP(S)，不能包含账号、密码或片段。');
  return url;
}
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
export function normalizeAdvice(
  raw: unknown,
  stats: Statistics,
  source: string,
): Advice {
  const data = object(raw);
  if (typeof data.summary !== 'string' || !Array.isArray(data.suggestions))
    throw new Error('建议接口需返回 summary 和 suggestions[]。');
  const suggestions = data.suggestions.map((value) => {
    const item = object(value);
    if (
      typeof item.action !== 'string' ||
      !item.action.trim() ||
      typeof item.basis !== 'string' ||
      !item.basis.trim()
    )
      throw new Error('每条建议必须包含 action 和 basis。');
    return {
      action: item.action,
      basis: item.basis,
      limitation: typeof item.limitation === 'string' ? item.limitation : '',
    };
  });
  return {
    summary: data.summary,
    suggestions,
    source,
    generatedAt: Date.now(),
    start: stats.start,
    end: stats.end,
    days: stats.days,
  };
}

import { request } from './api';
import type { Language } from './locale';
export * from './analysis-contract';
import { endpoint, normalizeStats, normalizeAdvice } from './analysis-contract';
import type {
  ApiSettings,
  Statistics,
  Advice,
  ZoneStat,
} from './analysis-contract';
async function external(url: URL, body?: unknown) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`接口请求失败（HTTP ${response.status}）`);
  return response.json() as Promise<unknown>;
}
type BackendReport = {
  start_at: number;
  generated_at: number;
  source: string;
  model: string | null;
  note: string | null;
  stats: {
    opened: number;
    closed: number;
    mean_minutes: number | null;
    hourly: number[];
    zones: ZoneStat[];
  };
  suggestions: { action: string; evidence: string }[];
};
export async function loadStatistics(
  settings: ApiSettings,
  days: number,
  language: Language,
): Promise<Statistics> {
  if (settings.statsMode === 'backend') {
    const report = await request<BackendReport>(
      `/api/analysis?days=${days}&lang=${language}&scope=collection`,
    );
    return {
      ...normalizeStats(
        {
          total: report.stats.opened,
          resolved: report.stats.closed,
          avg_wait: report.stats.mean_minutes,
          hourly: report.stats.hourly,
          zones: report.stats.zones,
        },
        {
          start: report.start_at,
          end: report.generated_at,
          days,
          source: 'backend',
        },
      ),
      rules: report.suggestions,
    };
  }
  const end = Date.now(),
    start = end - days * 86_400_000;
  const url = endpoint(settings.statsUrl);
  for (const [key, value] of Object.entries({
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    days: String(days),
    timezone: 'Asia/Shanghai',
  }))
    url.searchParams.set(key, value);
  return normalizeStats(await external(url), {
    start,
    end,
    days,
    source: url.origin,
  });
}
export async function generateAdvice(
  settings: ApiSettings,
  stats: Statistics,
  language: Language,
): Promise<Advice> {
  if (settings.adviceMode === 'custom') {
    const url = endpoint(settings.adviceUrl);
    const statistics = {
      total: stats.total,
      resolved: stats.resolved,
      avg_wait: stats.average,
      hourly: stats.hourly,
      zones: stats.zones,
    };
    return normalizeAdvice(
      await external(url, {
        period_start: new Date(stats.start).toISOString(),
        period_end: new Date(stats.end).toISOString(),
        period_days: stats.days,
        timezone: 'Asia/Shanghai',
        data_source: stats.source === 'backend' ? 'simulation' : 'custom-api',
        statistics,
      }),
      stats,
      url.origin,
    );
  }
  if (settings.adviceMode === 'deepseek') {
    if (settings.statsMode !== 'backend')
      throw new Error('服务端 DeepSeek 使用内置统计，请先切换统计来源。');
    const report = await request<BackendReport>('/api/analysis', {
      days: stats.days,
      lang: language,
      scope: 'collection',
    });
    if (report.source !== 'deepseek')
      throw new Error(report.note ?? 'DeepSeek unavailable');
    return {
      summary:
        language === 'en'
          ? 'Recommendations from server aggregates'
          : '根据服务端统计生成的巡检建议',
      suggestions: report.suggestions.map((item) => ({
        action: item.action,
        basis: item.evidence,
        limitation: '',
      })),
      generatedAt: report.generated_at,
      source:
        report.source === 'deepseek' ? `DeepSeek / ${report.model}` : 'rules',
      note: report.note ?? undefined,
      start: report.start_at,
      end: report.generated_at,
      days: stats.days,
    };
  }
  const en = language === 'en';
  const rules = stats.rules.length
    ? stats.rules
    : [
        {
          action: en
            ? 'Review the busiest area before changing inspection schedules.'
            : '先复核事件最多的分区，再决定是否调整巡检频次。',
          evidence: (() => {
            const zone = [...stats.zones].sort(
              (a, b) => b.events - a.events,
            )[0];
            return zone && zone.events > 0
              ? `${zone.name}: ${zone.events} / ${stats.total}`
              : en
                ? 'No events in this reporting period.'
                : '当前统计周期没有满桶事件。';
          })(),
        },
      ];
  return {
    summary: en
      ? 'Rule-based recommendations from the selected statistics'
      : '根据所选统计结果整理的巡检建议',
    suggestions: rules.map((item) => ({
      action: item.action,
      basis: item.evidence,
      limitation: en
        ? 'Validate with real operation data.'
        : '需用实际运行数据验证。',
    })),
    generatedAt: Date.now(),
    source: 'rules',
    start: stats.start,
    end: stats.end,
    days: stats.days,
  };
}

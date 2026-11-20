import { request } from './api';
import type { Language } from './locale';
export * from './analysis-contract';
import { normalizeStats, supportsAdvice } from './analysis-contract';
import type {
  ModelApi,
  Statistics,
  Advice,
  ZoneStat,
} from './analysis-contract';
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
  days: number,
  language: Language,
): Promise<Statistics> {
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
export async function generateAdvice(
  model: ModelApi,
  stats: Statistics,
  language: Language,
): Promise<Advice> {
  if (!supportsAdvice(model))
    throw new Error('所选模型尚未接入，请先选择其他模型。');
  if (model === 'deepseek') {
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

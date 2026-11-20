import { useState } from 'react';
import { BarChart3, Sparkles } from 'lucide-react';
import { errorText, request } from './api';

type Days = 7 | 28;
type Report = {
  days: Days;
  start_at: number;
  generated_at: number;
  source: 'deepseek' | 'rules';
  model: string | null;
  note: string | null;
  stats: {
    opened: number;
    closed: number;
    active: number;
    long_wait: number;
    timed: number;
    mean_minutes: number | null;
  };
  suggestions: { action: string; evidence: string }[];
};

const shanghaiTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function DispatchAnalysis({ connected }: { connected: boolean }) {
  const [days, setDays] = useState<Days>(7);
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const current = report?.days === days ? report : null;

  async function generate() {
    setError('');
    setPending(true);
    try {
      setReport(await request<Report>('/api/analysis', { days }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel dispatch-analysis" aria-labelledby="analysis-title" aria-busy={pending}>
      <div className="panel-heading analysis-heading">
        <span className="section-icon"><BarChart3 size={21} /></span>
        <div><h2 id="analysis-title">清运分析</h2><p>按工单创建时间统计 · 演示数据</p></div>
        <div className="analysis-controls">
          <div className="analysis-range" role="group" aria-label="分析时间范围">
            {([7, 28] as const).map((range) => (
              <button type="button" key={range} aria-pressed={range === days} disabled={pending} onClick={() => { setDays(range); setError(''); }}>
                近 {range} 天
              </button>
            ))}
          </div>
          <button type="button" className="primary analysis-generate" disabled={!connected || pending} onClick={() => void generate()}>
            <Sparkles size={17} /> {pending ? '正在分析…' : '生成分析'}
          </button>
        </div>
      </div>
      {error && <p className="callout error" role="alert">{error}</p>}
      {current ? (
        <div className="analysis-result">
          <div className="analysis-context">
            <span className={'analysis-source ' + current.source}>{current.source === 'deepseek' ? 'DeepSeek · ' + current.model : '本地规则'}</span>
            <span>{shanghaiTime.format(current.start_at)} 至 {shanghaiTime.format(current.generated_at)}（北京时间）</span>
          </div>
          <dl className="analysis-metrics">
            <div><dt>满桶工单</dt><dd>{current.stats.opened}</dd></div>
            <div><dt>已关闭</dt><dd>{current.stats.closed}</dd></div>
            <div><dt>等待至少 20 分钟</dt><dd>{current.stats.long_wait}</dd></div>
            <div>
              <dt>平均关闭耗时</dt>
              <dd>{current.stats.mean_minutes === null ? '—' : current.stats.mean_minutes.toFixed(1) + ' 分钟'}</dd>
              {current.stats.timed > 0 && <small>来自 {current.stats.timed} 条带关闭时间的工单</small>}
            </div>
          </dl>
          {current.suggestions.length > 0 && (
            <ul className="analysis-suggestions" aria-label="清运建议">
              {current.suggestions.map((suggestion) => (
                <li key={suggestion.evidence}>
                  <strong>{suggestion.action}</strong>
                  <p><span>依据</span>{suggestion.evidence}</p>
                </li>
              ))}
            </ul>
          )}
          {current.note && <p className="analysis-note">{current.note}</p>}
        </div>
      ) : <p className="analysis-empty">{pending ? '正在汇总工单与复核状态。' : '生成统计摘要和基于当前工单的清运建议。'}</p>}
    </section>
  );
}

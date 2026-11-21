import { useEffect, useRef, useState } from 'react';
import { BarChart3, Sparkles } from 'lucide-react';
import { errorText } from './api';
import { DeepSeekSettings } from './deepseek-settings';
import { useLocale } from './locale';
import { generateAdvice, loadStatistics } from './analysis-api';
import type { Advice, Statistics } from './analysis-api';

export function DispatchAnalysis({
  connected,
  revision,
}: {
  connected: boolean;
  revision: string;
}) {
  const { t, text, language } = useLocale();
  const [days, setDays] = useState<7 | 28>(7);
  const [configVersion, setConfigVersion] = useState(0);
  const [stats, setStats] = useState<{ key: string; data: Statistics } | null>(
    null,
  );
  const [advice, setAdvice] = useState<{ key: string; data: Advice } | null>(
    null,
  );
  const [loading, setLoading] = useState(false),
    [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const serial = useRef(0);
  const context = JSON.stringify([configVersion, days, language]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const key = JSON.stringify([days, language, revision]);
  const adviceKey = context + revision;
  const currentKey = useRef(key);
  currentKey.current = key;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      serial.current++;
    };
  }, []);
  async function refresh() {
    const run = ++serial.current;
    setLoading(true);
    setError('');
    try {
      const data = await loadStatistics(days, language);
      if (
        mounted.current &&
        run === serial.current &&
        currentKey.current === key
      )
        setStats({ key, data });
    } catch (cause) {
      if (mounted.current && run === serial.current) setError(errorText(cause));
    } finally {
      if (mounted.current && run === serial.current) setLoading(false);
    }
  }
  useEffect(() => {
    serial.current++;
    setLoading(false);
    setError('');
    if (connected) void refresh();
    return () => {
      serial.current++;
    };
  }, [connected, key]);
  async function generate(mode: 'none' | 'deepseek' = 'deepseek') {
    setGenerating(true);
    setError('');
    try {
      const data = await loadStatistics(days, language);
      if (!mounted.current || currentContext.current !== context) return;
      if (currentKey.current === key) setStats({ key, data });
      const result = await generateAdvice(mode, data, language);
      if (mounted.current && currentContext.current === context)
        setAdvice({ key: adviceKey, data: result });
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      if (mounted.current) setGenerating(false);
    }
  }
  const time = (value: number) =>
    new Intl.DateTimeFormat(language, {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(value);
  const source = (value: string) =>
    value === 'backend'
      ? t('工单统计')
      : value === 'rules'
        ? t('系统基础建议')
        : value;
  const data = stats?.data;
  const max = Math.max(1, ...(data?.hourly ?? []));
  return (
    <section className="dispatch-analysis" aria-labelledby="analysis-title">
      <div className="panel-heading analysis-heading">
        <span className="section-icon">
          <BarChart3 size={21} />
        </span>
        <div>
          <h2 id="analysis-title">{t('清运分析')}</h2>
          <p>{t('统计图表来自工单记录，智能建议由 DeepSeek 生成。')}</p>
        </div>
        <div className="analysis-controls">
          <div
            className="analysis-range"
            role="group"
            aria-label={t('分析时间范围')}
          >
            {([7, 28] as const).map((range) => (
              <button
                type="button"
                key={range}
                aria-pressed={range === days}
                disabled={generating}
                onClick={() => setDays(range)}
              >
                {t('近 {days} 天', { days: range })}
              </button>
            ))}
          </div>
        </div>
      </div>
      <DeepSeekSettings
        disabled={generating}
        onSaved={() => setConfigVersion((v) => v + 1)}
      />
      {error && (
        <p className="callout error" role="alert">
          {text(error)} {t('已有结果会保留，清运操作不受影响。')}
        </p>
      )}
      {!connected && (
        <p className="callout error">{t('连接中断，以下分析可能已过期。')}</p>
      )}
      <section className="statistics-section">
        <div className="subsection-heading">
          <h3>{t('统计分析')}</h3>
          <button
            className="outline"
            disabled={!connected || loading || generating}
            onClick={() => void refresh()}
          >
            {t(loading ? '正在加载…' : '更新统计')}
          </button>
        </div>
        {data ? (
          <>
            <p className="analysis-provenance">
              {source(data.source)} · {time(data.start)} — {time(data.end)} ·
              Asia/Shanghai · {t('模拟数据')}
            </p>
            {stats.key !== key && (
              <p className="stale-result" role="status">
                {t('显示上次成功结果，请更新以纳入当前范围与数据。')}
              </p>
            )}
            <dl className="analysis-metrics">
              <div>
                <dt>{t('满桶工单')}</dt>
                <dd>{data.total}</dd>
              </div>
              <div>
                <dt>{t('已完成')}</dt>
                <dd>{data.resolved ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('平均关闭耗时')}</dt>
                <dd>
                  {data.average == null
                    ? '—'
                    : t('{minutes} 分钟', { minutes: data.average.toFixed(1) })}
                </dd>
              </div>
              <div>
                <dt>{t('覆盖分区')}</dt>
                <dd>{data.zones.length}</dd>
              </div>
            </dl>
            <div className="statistics-grid">
              <div>
                <h4>{t('分区统计')}</h4>
                <div className="history-scroll">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>{t('分区')}</th>
                        <th>{t('垃圾桶数')}</th>
                        <th>{t('满桶工单')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.zones]
                        .sort((a, b) => b.events - a.events)
                        .map((zone) => (
                          <tr key={zone.name}>
                            <td>{text(zone.name)}</td>
                            <td>{zone.bin_count ?? '—'}</td>
                            <td>{zone.events}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h4>{t('满桶时段分布')}</h4>
                <div
                  className="hour-chart"
                  role="img"
                  aria-label={t('按北京时间统计的每小时满桶次数')}
                >
                  {data.hourly.map((value, hour) => (
                    <div key={hour} title={`${hour}:00 · ${value}`}>
                      <span
                        style={{
                          height: `${Math.max(value > 0 ? 3 : 0, (value / max) * 100)}%`,
                        }}
                      />
                      <small>{hour % 3 === 0 ? hour : ''}</small>
                    </div>
                  ))}
                </div>
                <details>
                  <summary>{t('查看每小时次数')}</summary>
                  <p className="hour-values">
                    {data.hourly
                      .map((value, hour) => `${hour}:00 — ${value}`)
                      .join(' · ')}
                  </p>
                </details>
                <p className="analysis-provenance">
                  {t(
                    '每个站点含四类桶；分区数量按垃圾桶计，平均耗时只统计已关闭工单。',
                  )}
                </p>
              </div>
            </div>
          </>
        ) : (
          <p className="analysis-empty">
            {t(loading ? '正在加载…' : '点击更新统计，查看工单记录。')}
          </p>
        )}
      </section>
      <section className="advice-section">
        <div className="subsection-heading">
          <h3>{t('智能建议')}</h3>
          <div className="deepseek-actions">
            <button
              className="outline"
              disabled={!connected || generating || loading}
              onClick={() => void generate('none')}
            >
              {t('查看基础建议')}
            </button>
            <button
              className="primary"
              disabled={!connected || generating || loading}
              onClick={() => void generate()}
            >
              <Sparkles size={17} />
              {t(generating ? '正在分析…' : '生成智能建议')}
            </button>
          </div>
        </div>
        <p className="analysis-provenance">
          {t(
            '基础建议不调用模型。生成智能建议需要组内登录及有效的 DeepSeek 配置。',
          )}
        </p>
        {advice ? (
          <>
            <div className="analysis-context">
              <span className="analysis-source">
                {source(advice.data.source)}
              </span>
              <span>
                {t('生成时间：{time}', { time: time(advice.data.generatedAt) })}
              </span>
              <span>
                {time(advice.data.start)} — {time(advice.data.end)}
              </span>
            </div>
            {advice.key !== adviceKey && (
              <p className="stale-result">
                {t('显示上次成功结果，请更新以纳入当前范围与数据。')}
              </p>
            )}
            <p className="advice-summary">{advice.data.summary}</p>
            <ul className="analysis-suggestions">
              {advice.data.suggestions.map((item, i) => (
                <li key={i}>
                  <strong>{item.action}</strong>
                  <p>
                    <span>{t('依据')}</span>
                    {item.basis}
                  </p>
                  {item.limitation && <small>{item.limitation}</small>}
                </li>
              ))}
            </ul>
            {advice.data.note && (
              <p className="analysis-note">{advice.data.note}</p>
            )}
          </>
        ) : (
          <p className="analysis-empty">{t('暂无建议，点击上方按钮生成。')}</p>
        )}
      </section>
    </section>
  );
}

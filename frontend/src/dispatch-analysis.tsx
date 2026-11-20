import { useEffect, useRef, useState } from 'react';
import { BarChart3, Settings2, Sparkles } from 'lucide-react';
import { errorText } from './api';
import { useLocale } from './locale';
import {
  defaultSettings,
  endpoint,
  generateAdvice,
  loadStatistics,
  restoreSettings,
  settingsKey,
} from './analysis-api';
import type { Advice, ApiSettings, Statistics } from './analysis-api';

export function DispatchAnalysis({
  connected,
  revision,
}: {
  connected: boolean;
  revision: string;
}) {
  const { t, text, language } = useLocale();
  const [days, setDays] = useState<7 | 28>(7);
  const [settings, setSettings] = useState<ApiSettings>(() => {
    try {
      return restoreSettings(localStorage.getItem(settingsKey));
    } catch {
      return { ...defaultSettings };
    }
  });
  const [draft, setDraft] = useState(settings);
  const [showSettings, setShowSettings] = useState(false);
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
  const context = JSON.stringify([settings, days, language]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const key = context + revision;
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
      const data = await loadStatistics(settings, days, language);
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
    if (connected && settings.statsMode === 'backend') void refresh();
    return () => {
      serial.current++;
    };
  }, [connected, key]);
  function save() {
    try {
      if (draft.statsMode === 'custom') endpoint(draft.statsUrl);
      if (draft.adviceMode === 'custom') endpoint(draft.adviceUrl);
      if (draft.statsMode === 'custom' && draft.adviceMode === 'deepseek')
        throw new Error(t('服务端 DeepSeek 使用内置统计，请先切换统计来源。'));
      localStorage.setItem(settingsKey, JSON.stringify(draft));
      setSettings({ ...draft });
      setError('');
      setShowSettings(false);
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  async function generate() {
    setGenerating(true);
    setError('');
    try {
      const data = await loadStatistics(settings, days, language);
      if (!mounted.current || currentContext.current !== context) return;
      if (currentKey.current === key) setStats({ key, data });
      const result = await generateAdvice(settings, data, language);
      if (mounted.current && currentContext.current === context)
        setAdvice({ key, data: result });
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
      ? t('内置后端统计')
      : value === 'rules'
        ? t('本地规则')
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
          <p>{t('统计分析与智能建议使用独立接口，可分别选择。')}</p>
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
          <button
            className="outline"
            onClick={() => {
              setDraft(settings);
              setShowSettings(!showSettings);
            }}
          >
            <Settings2 size={16} />
            {t('接口设置')}
          </button>
        </div>
      </div>
      {showSettings && (
        <div className="api-settings">
          <h3>{t('统计与建议接口')}</h3>
          <p>{t('仅保存接口地址和选择；模型密钥继续配置在服务端。')}</p>
          <div className="api-settings-grid">
            <label>
              {t('统计分析接口')}
              <select
                aria-label={t('统计分析接口')}
                value={draft.statsMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    statsMode: e.target.value as ApiSettings['statsMode'],
                    adviceMode:
                      e.target.value === 'custom' &&
                      draft.adviceMode === 'deepseek'
                        ? 'rules'
                        : draft.adviceMode,
                  })
                }
              >
                <option value="backend">{t('内置后端统计')}</option>
                <option value="custom">{t('自定义 HTTP 接口')}</option>
              </select>
            </label>
            <label>
              {t('智能建议接口')}
              <select
                aria-label={t('智能建议接口')}
                value={draft.adviceMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    adviceMode: e.target.value as ApiSettings['adviceMode'],
                  })
                }
              >
                <option value="rules">{t('本地规则')}</option>
                <option
                  value="deepseek"
                  disabled={draft.statsMode === 'custom'}
                >
                  {t('服务端 DeepSeek')}
                </option>
                <option value="custom">{t('自定义 HTTP 接口')}</option>
              </select>
            </label>
            <label>
              {t('统计接口地址（GET）')}
              <input
                type="url"
                value={draft.statsUrl}
                placeholder="https://example.com/statistics"
                onChange={(e) =>
                  setDraft({ ...draft, statsUrl: e.target.value })
                }
              />
            </label>
            <label>
              {t('建议接口地址（POST）')}
              <input
                type="url"
                value={draft.adviceUrl}
                placeholder="https://example.com/advice"
                onChange={(e) =>
                  setDraft({ ...draft, adviceUrl: e.target.value })
                }
              />
            </label>
          </div>
          <p>
            {t(
              '自定义接口需要允许 CORS。生成建议时只发送汇总统计；请勿在地址中填写密钥。',
            )}
          </p>
          <details className="api-contract">
            <summary>{t('查看接口格式')}</summary>
            <p>
              GET ?from=ISO&amp;to=ISO&amp;days=7|28&amp;timezone=Asia/Shanghai
            </p>
            <pre>
              {
                '{ total, resolved?, avg_wait?, hourly: [24 numbers], zones: [{ name, events, bin_count? }] }'
              }
            </pre>
            <p>
              POST{' '}
              {
                '{ period_start, period_end, period_days, timezone, data_source, statistics }'
              }
            </p>
            <pre>
              {'{ summary, suggestions: [{ action, basis, limitation? }] }'}
            </pre>
          </details>
          <div className="api-buttons">
            <button className="primary" onClick={save} disabled={generating}>
              {t('保存接口设置')}
            </button>
            <button
              className="outline"
              onClick={() => setDraft({ ...defaultSettings })}
            >
              {t('恢复默认选项')}
            </button>
          </div>
        </div>
      )}
      <div className="analysis-provider-summary">
        <span>
          {t('统计分析接口')}：
          <b>
            {settings.statsMode === 'backend'
              ? t('内置后端统计')
              : settings.statsUrl}
          </b>
        </span>
        <span>
          {t('智能建议接口')}：
          <b>
            {settings.adviceMode === 'rules'
              ? t('本地规则')
              : settings.adviceMode === 'deepseek'
                ? t('服务端 DeepSeek')
                : settings.adviceUrl}
          </b>
        </span>
      </div>
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
              Asia/Shanghai ·{' '}
              {t(data.source === 'backend' ? '模拟数据' : '外部接口数据')}
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
                        <th>{t('点位数')}</th>
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
                    '没有事件的点位仍计入分区点位数；平均耗时只统计已关闭工单。',
                  )}
                </p>
              </div>
            </div>
          </>
        ) : (
          <p className="analysis-empty">
            {t(loading ? '正在加载…' : '点击更新统计，读取所选接口。')}
          </p>
        )}
      </section>
      <section className="advice-section">
        <div className="subsection-heading">
          <h3>{t('智能建议')}</h3>
          <button
            className="primary"
            disabled={!connected || generating || loading}
            onClick={() => void generate()}
          >
            <Sparkles size={17} />
            {t(generating ? '正在分析…' : '生成分析')}
          </button>
        </div>
        <p className="analysis-provenance">
          {t(
            '点击生成后调用所选接口；结果基于汇总事件，不用于自动指派人员或规划路线。',
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
            {advice.key !== key && (
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
          <p className="analysis-empty">
            {t('尚未生成建议，点击生成分析开始。')}
          </p>
        )}
      </section>
    </section>
  );
}

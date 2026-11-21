import { useEffect, useRef, useState } from 'react';
import { Bell, Check, ClipboardList, Clock3, History, ShieldCheck, TriangleAlert, Wifi, X } from 'lucide-react';
import { binLabels, ticketLabels, categories, categoryOrder } from './domain';
import type { Snapshot, Ticket, Category } from './domain';
import { CollectionMap } from './collection-map';
import { DispatchAnalysis } from './dispatch-analysis';
import { useLocale } from './locale';
import { actionable, closedOn, dayKey, eventKey, oldestFirst, overdue, deviceOnline } from './cleaner-model';

type QueueFilter = 'all' | 'overdue' | 'verify';
export function Cleaner({ state, connected, busy, lastUpdated, onCollect }: {
  state: Snapshot | null; connected: boolean; busy: boolean;
  lastUpdated: number | null; onCollect: (id: number) => void;
}) {
  const { language, t, text } = useLocale();
  const [now, setNow] = useState(Date.now);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [stationId, setStationId] = useState('all');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [zone, setZone] = useState('all');
  const [activePanel, setActivePanel] = useState<'history'|'analysis'>('history');
  const [historyDate, setHistoryDate] = useState('');
  const [notice, setNotice] = useState<{ count: number; overdue: number } | null>(null);
  const seen = useRef<{ events: Set<string>; late: Set<string> } | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!state || !connected) return;
    const active = state.tickets.filter((ticket) => ticket.status !== 'closed');
    const events = active.map(eventKey);
    const late = active.filter((ticket) => overdue(ticket, now)).map(eventKey);
    if (!seen.current) {
      seen.current = { events: new Set(events), late: new Set(late) };
      return;
    }
    const count = events.filter((key) => !seen.current!.events.has(key)).length;
    const overdueCount = late.filter((key) => !seen.current!.late.has(key)).length;
    events.forEach((key) => seen.current!.events.add(key));
    late.forEach((key) => seen.current!.late.add(key));
    if (count || overdueCount) setNotice({ count, overdue: overdueCount });
  }, [state, connected, now]);

  const active = oldestFirst(state?.tickets.filter((ticket) => ticket.status !== 'closed') ?? []);
  const pending = active.filter(actionable);
  const late = active.filter((ticket) => overdue(ticket, now));
  const online = state?.bins.filter(bin => deviceOnline(bin, now)).length ?? 0;
  const zones = [...new Set(state?.stations.map(point => point.zone ?? point.detail) ?? [])];
  const completed = (state?.tickets ?? []).filter((ticket) => ticket.status === 'closed');
  const today = completed.filter((ticket) => closedOn(ticket, dayKey(now))).length;
  const binOf = (ticket: Ticket) => state?.bins.find((bin) => bin.id === ticket.bin_id);
  const matchesStation = (ticket: Ticket) => {
    const id=binOf(ticket)?.station_id;
    return (category === 'all' || binOf(ticket)?.category === category) && (stationId === 'all' || id === stationId) && (zone==='all' || state?.stations.find(point=>point.id===id)?.zone===zone);
  };
  const queue = active.filter(matchesStation).filter((ticket) =>
    filter === 'overdue' ? overdue(ticket, now) : filter === 'verify' ? ticket.status === 'awaiting_verify' : true);
  const history = completed.filter(matchesStation)
    .filter((ticket) => !historyDate || closedOn(ticket, historyDate))
    .sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  const revision = state?.tickets.map((ticket) => `${eventKey(ticket)}:${ticket.status}:${ticket.closed_at}`).join(',') ?? '';
  const time = (value: number | null | undefined) => value == null ? '—' : new Intl.DateTimeFormat(language, {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(value);
  const duration = (start: number, end = now) => {
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    return t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  };

  return (
    <div className="cleaner-dashboard cleaner-v2">
      <div className="operations-overview">
      <div className="operations-context">
        <span>{t('全校 {stations} 个站点 · {bins} 个分类垃圾桶', { stations: state?.stations.length ?? 0, bins: state?.bins.length ?? 0 })}</span>
        <span className={connected ? 'sync-stamp' : 'sync-stamp stale'}>{t(connected ? '最近同步：{time}' : '数据可能过期 · 最近同步：{time}', { time: time(lastUpdated) })}</span>
      </div>
      <div className="operations-metrics">
        {[
          { label: '待清运', value: pending.length, icon: ClipboardList, tone: '' },
          { label: '超时待处理', value: late.length, icon: TriangleAlert, tone: 'warning' },
          { label: '今日已完成', value: today, icon: Check, tone: 'done' },
          { label: '在线设备', value: connected ? `${online} / ${state?.bins.length ?? 80}` : '—', icon: Wifi, tone: 'verify' },
        ].map(({ label, value, icon: Icon, tone }) => (
          <div className={'operations-metric ' + tone} key={label}>
            <Icon size={20} /><span>{text(label)}</span><strong>{state ? value : '—'}</strong>
          </div>
        ))}
      </div>
      <div className="operations-note"><Clock3 size={16} /><span>{t('超时阈值 20 分钟；在线表示 2 小时内收到有效上报且状态已知。今日完成按复核关闭计，时间为北京时间。')}</span></div>
      {notice && <div className="event-notice" role="status">
        <Bell size={18} /><span>{t('新增 {count} 条满桶提醒，{overdue} 条任务进入超时。', notice)}</span>
        <button className="icon-button" aria-label={t('关闭提醒')} onClick={() => setNotice(null)}><X size={17} /></button>
      </div>}
      <div className="collection-toolbar"><label>{t('分区筛选')}<select aria-label={t('分区筛选')} value={zone} onChange={e=>{setZone(e.target.value);setStationId('all');}}><option value="all">{t('全部分区')}</option>{zones.map(value=><option key={value} value={value}>{text(value)}</option>)}</select></label><span>{t('点位与工单来自同一份后端数据。')}</span></div>
      </div>
      <div className="operations-grid">
        {state ? <CollectionMap state={state} now={now} zone={zone} selectedId={stationId} onSelect={id=>{setStationId(id);if(id!=='all')setZone('all');}} /> : <section className="panel queue-empty">{t('等待后端连接')}</section>}
        <section className="panel operations-queue" aria-labelledby="queue-title" data-testid="queue">
          <div className="panel-heading"><span className="section-icon"><ClipboardList size={21} /></span>
            <div><h2 id="queue-title">{t('清运工单')}</h2><p>{t('按首次满桶时间排序，优先处理等待最久的任务。')}</p></div>
          </div>
          <div className="queue-filters">
          <label className="operations-select">{t('站点筛选')}
            <select value={stationId} onChange={(event) => setStationId(event.target.value)}>
              <option value="all">{t('全部站点')}</option>
              {state?.stations.filter(point=>zone==='all'||point.zone===zone).map((station) => <option key={station.id} value={station.id}>{station.code ?? station.id} · {text(station.name)}</option>)}
            </select>
          </label>
          <label className="operations-select">{t('垃圾桶类型')}
            <select value={category} onChange={event => setCategory(event.target.value as Category | 'all')}>
              <option value="all">{t('全部四类垃圾桶')}</option>
              {categoryOrder.map(key => <option key={key} value={key}>{t(categories[key].label)}</option>)}
            </select>
          </label>
          </div>
          <p className="verification-note station-filter-help">{t('每站包含：可回收物、厨余垃圾、其他垃圾、有害垃圾。地图每站显示一个点。')}</p>
          <div className="queue-tabs" role="group" aria-label={t('工单筛选')}>
            {([['all', '全部进行中'], ['overdue', '超时待处理'], ['verify', '待传感器确认']] as const).map(([value, label]) =>
              <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}</button>)}
          </div>
          <p className="verification-note">{t('确认清运后进入待复核；设备重新上报未满后，工单才会关闭。')}</p>
          {!queue.length ? <div className="queue-empty"><Check size={20} />{t(connected ? '当前筛选下暂无工单' : '等待工单同步')}</div> :
            <ul className="operations-tickets">{queue.map((ticket) => {
              const bin = binOf(ticket);
              if (!bin) return null;
              const station = state?.stations.find((item) => item.id === bin.station_id);
              const isLate = overdue(ticket, now);
              return <li className={'operation-ticket' + (isLate ? ' overdue' : '')} key={eventKey(ticket)} data-testid="ticket" data-ticket-status={ticket.status}>
                <div className="operation-ticket-title"><strong>{text(station?.name ?? bin.station_id)}</strong>
                  <span className={'status-chip ' + (isLate ? 'overdue' : '')}>{t(isLate ? '超时待处理' : ticketLabels[ticket.status])}</span></div>
                <div className="ticket-identifiers">{t(categories[bin.category].label)} · {bin.display_id ?? bin.id} · #{ticket.id}</div>
                <dl className="ticket-times"><div><dt>{t('首次检测满桶')}</dt><dd>{time(ticket.opened_at)}</dd></div>
                  <div><dt>{t(ticket.status === 'awaiting_verify' ? '事件持续时间' : '已等待')}</dt><dd>{duration(ticket.opened_at)}</dd></div></dl>
                <div className="operation-ticket-footer"><span>{t('设备状态')}：{t(deviceOnline(bin,now)?binLabels[bin.status]:'离线或未知')}</span>
                  {actionable(ticket) ? <button className="primary" onClick={() => onCollect(ticket.id)} disabled={busy || !connected}><Check size={16} />{t('确认已清运')}</button>
                    : <span className="verification-label"><ShieldCheck size={15} />{t('等待设备复核')}</span>}
                </div>
              </li>;
            })}</ul>}
        </section>
      </div>
      <section className="panel records-panel">
      <div className="records-tabs" role="tablist" aria-label={t('记录与分析')}>
        {(['history','analysis'] as const).map((value,index)=><button key={value} id={`tab-${value}`} role="tab" aria-selected={activePanel===value} aria-controls={`panel-${value}`} tabIndex={activePanel===value?0:-1}
          onClick={()=>setActivePanel(value)} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const other=value==='history'?'analysis':'history';setActivePanel(other);(e.currentTarget.parentElement?.children[1-index] as HTMLElement)?.focus();}}}>{t(value==='history'?'清运历史':'清运分析')}</button>)}
      </div>
      <div className="history-panel" id="panel-history" role="tabpanel" aria-labelledby="tab-history" hidden={activePanel!=='history'}>
        <div className="panel-heading"><span className="section-icon"><History size={21} /></span>
          <div><h2 id="history-title">{t('清运历史')}</h2><p>{t('完成时间以设备复核关闭为准；沿用上方站点筛选。')}</p></div>
          <label className="history-date">{t('完成日期')}<input type="date" aria-label={t('完成日期')} value={historyDate} onChange={(event) => setHistoryDate(event.target.value)} /></label>
          <button className="outline" onClick={() => setHistoryDate(dayKey(now))}>{t('今天')}</button>
          {historyDate && <button className="outline" onClick={() => setHistoryDate('')}>{t('全部日期')}</button>}
        </div>
        {history.length ? <div className="history-scroll" tabIndex={0} role="region" aria-label={t('清运历史')}><table className="history-table">
          <thead><tr>{['点位 / 桶号', '首次检测满桶', '复核完成时间', '关闭耗时'].map((label) => <th key={label} scope="col">{text(label)}</th>)}</tr></thead>
          <tbody>{history.map((ticket) => {
            const bin = binOf(ticket);
            const station = state?.stations.find((item) => item.id === bin?.station_id);
            return <tr key={eventKey(ticket)}><td><strong>{text(station?.name ?? ticket.bin_id)}</strong><small>{bin ? t(categories[bin.category].label) : ''} · {bin?.display_id ?? ticket.bin_id} · #{ticket.id}</small></td>
              <td>{time(ticket.opened_at)}</td><td>{time(ticket.closed_at)}</td><td>{ticket.closed_at == null ? '—' : duration(ticket.opened_at, ticket.closed_at)}</td></tr>;
          })}</tbody>
        </table></div> : <div className="queue-empty">{t('当前筛选下暂无已完成记录')}</div>}
        {!!state?.retired_tickets?.length && <details className="retired-records">
          <summary>{t('已移除站点记录')} · {state.retired_tickets.length}</summary>
          <p className="verification-note">{t('旧站点工单保留供查阅，不计入当前站点地图、指标和分析。')}</p>
          <div className="history-scroll"><table className="history-table"><thead><tr><th>{t('站点筛选')}</th><th>{t('工单状态')}</th><th>{t('首次检测满桶')}</th><th>{t('复核完成时间')}</th></tr></thead>
          <tbody>{state.retired_tickets.map(ticket => {
            const bin = state.retired_bins?.find(bin => bin.id === ticket.bin_id);
            const point = state.retired_collection_points?.find(point => point.station_id === bin?.station_id);
            return <tr key={eventKey(ticket)}><td><strong>{text(point?.name ?? ticket.bin_id)}</strong><small>{t('旧编号')}：{ticket.bin_id} · #{ticket.id}</small></td><td>{t(ticketLabels[ticket.status])}</td><td>{time(ticket.opened_at)}</td><td>{time(ticket.closed_at)}</td></tr>;
          })}</tbody></table></div>
        </details>}
      </div>
      <div id="panel-analysis" role="tabpanel" aria-labelledby="tab-analysis" hidden={activePanel!=='analysis'}><DispatchAnalysis connected={connected} revision={revision} /></div>
      </section>
    </div>
  );
}

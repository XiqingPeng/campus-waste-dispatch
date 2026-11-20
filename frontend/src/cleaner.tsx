import { Check, ClipboardList, Clock3, Route, Truck } from 'lucide-react';
import { binLabels, categories, ticketLabels, waitLabel } from './domain';
import type { Snapshot, Ticket } from './domain';
import { CampusMap } from './campus-map';
import { DispatchAnalysis } from './dispatch-analysis';
import { useLocale } from './locale';
import type { Message } from './locale';

type Collect = (id: number) => void;

function primaryReason(ticket: Ticket, active: Ticket[]): Message {
  if (active.filter((item) => item.status === 'pending' || item.status === 'needs_review').length === 1) return '当前唯一可执行的清运任务';
  if (ticket.opened_at === Math.min(...active.filter((item) => item.status !== 'awaiting_verify').map((item) => item.opened_at))) {
    return '等待时间靠前，优先处理';
  }
  return '等待时间相近，优先处理较近的站点';
}

export function Cleaner({ state, connected, busy, onCollect }: {
  state: Snapshot | null; connected: boolean; busy: boolean; onCollect: Collect;
}) {
  const { t, text } = useLocale();
  const active = state?.tickets.filter((ticket) => ticket.status !== 'closed') ?? [];
  const next = active.find((ticket) => ticket.id === state?.recommendation);
  const nextBin = state?.bins.find((bin) => bin.id === next?.bin_id);
  const nextStation = state?.stations.find((station) => station.id === nextBin?.station_id);
  const ticketRevision = state?.tickets.map((ticket) => ticket.id + ':' + ticket.status).join(',') ?? '';

  return (
    <div className="cleaner-dashboard">
      <div className="cleaner-grid">
        {state && <CampusMap state={state} nextStation={nextStation} />}
        <div className="cleaner-left">
          <section className="next-panel" aria-labelledby="next-title">
            <div className="next-top"><Route size={19} /> <h2 id="next-title">{t('下一站')}</h2></div>
            {next && nextStation && nextBin ? (
              <>
                <div className="next-place">
                  <div><p>{text(nextStation.detail)}</p><h3>{text(nextStation.name)}</h3></div>
                  <span className="next-letter" aria-hidden>{nextStation.id.toUpperCase()}</span>
                </div>
                <div className="next-meta">
                  <span>{t(categories[nextBin.category].label)}</span>
                  <span><Clock3 size={15} /> {t('已等待 {time}', { time: waitLabel(next.opened_at, t) })}</span>
                </div>
                <div className="next-bottom">
                  <p>{t(primaryReason(next, active))}</p>
                  <button className="light-button" onClick={() => onCollect(next.id)} disabled={busy || !connected}><Check size={17} /> {t('确认已清运')}</button>
                </div>
              </>
            ) : (
              <div className="next-empty">
                <Truck size={47} strokeWidth={1.25} />
                <h3>{t(connected ? '暂无清运任务' : '等待后端连接')}</h3>
                <p>{t(active.length > 0 ? '当前工单正在等待桶位重新上报。' : '收到满桶上报后，这里会显示建议处理的站点。')}</p>
              </div>
            )}
          </section>
          <section className="panel queue-panel" aria-labelledby="queue-title" data-testid="queue">
            <div className="panel-heading">
              <span className="section-icon"><ClipboardList size={21} /></span>
              <div><h2 id="queue-title">{t('清运工单')}</h2><p>{t('{count} 条进行中', { count: active.length })}</p></div>
            </div>
            {active.length === 0 ? (
              <div className="queue-empty"><Check size={21} /> {t(connected ? '暂无进行中的工单' : '等待工单同步')}</div>
            ) : (
              <ul className="tickets">
                {active.map((ticket) => {
                  const bin = state?.bins.find((item) => item.id === ticket.bin_id);
                  if (!bin) return null;
                  const station = state?.stations.find((item) => item.id === bin.station_id);
                  const Icon = categories[bin.category].icon;
                  const executable = ticket.status === 'pending' || ticket.status === 'needs_review';
                  return (
                    <li key={ticket.id} className="ticket-row" data-ticket-status={ticket.status} data-testid="ticket">
                      <span className={'ticket-icon ' + bin.category}><Icon size={22} /></span>
                      <div className="ticket-description">
                        <strong>{t('{name}（{detail}）', { name: text(station?.name ?? ''), detail: t(categories[bin.category].label) })}</strong>
                        <span>{t('{status}，已等待 {time}', { status: t(ticketLabels[ticket.status]), time: waitLabel(ticket.opened_at, t) })}</span>
                      </div>
                      {ticket.id === next?.id ? (
                        <span className="status-chip priority">{t('优先')}</span>
                      ) : executable ? (
                        <button className="outline ticket-action" onClick={() => onCollect(ticket.id)} disabled={busy || !connected}>{t('标记已清运')}</button>
                      ) : (
                        <span className={'status-chip ' + bin.status}>{t(binLabels[bin.status])}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
      <DispatchAnalysis connected={connected} revision={ticketRevision} />
    </div>
  );
}

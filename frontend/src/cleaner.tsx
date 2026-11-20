import { Check, ClipboardList, Clock3, MapPin, Route, Truck } from 'lucide-react';
import { binLabels, categories, ticketLabels, waitLabel } from './domain';
import type { Snapshot, Station, Ticket } from './domain';

type Collect = (id: number) => void;

function primaryReason(ticket: Ticket, active: Ticket[]) {
  if (active.filter((item) => item.status === 'pending' || item.status === 'needs_review').length === 1) return '当前唯一可执行的清运任务';
  if (ticket.opened_at === Math.min(...active.filter((item) => item.status !== 'awaiting_verify').map((item) => item.opened_at))) {
    return '等待时间靠前，优先处理';
  }
  return '等待时间相近，优先处理较近的站点';
}

function CampusMap({ state, nextStation }: { state: Snapshot; nextStation?: Station }) {
  const xMin = Math.min(...state.stations.map((item) => item.x));
  const xRange = Math.max(...state.stations.map((item) => item.x)) - xMin || 1;
  const yMin = Math.min(...state.stations.map((item) => item.y));
  const yRange = Math.max(...state.stations.map((item) => item.y)) - yMin || 1;
  return (
    <section className="panel station-map-panel" aria-labelledby="map-title">
      <div className="panel-heading">
        <span className="section-icon"><MapPin size={21} /></span>
        <div><h2 id="map-title">宿舍区站点</h2><p>示意布局</p></div>
      </div>
      <div className="station-map" aria-hidden>
        <div className="map-walkway" />
        {state.stations.map((station) => (
          <div
            className={'map-point' + (nextStation?.id === station.id ? ' recommended' : '')}
            key={station.id}
            style={{ left: 17 + 66 * ((station.x - xMin) / xRange) + '%', top: 23 + 48 * ((station.y - yMin) / yRange) + '%' }}
          >
            <span>{station.id.toUpperCase()}</span><b>{station.name}</b>
          </div>
        ))}
      </div>
      <div className="map-stations">
        {state.stations.map((station) => {
          const bins = state.bins.filter((bin) => bin.station_id === station.id);
          const full = bins.filter((bin) => bin.status === 'full').length;
          const unknown = bins.filter((bin) => bin.status === 'unknown').length;
          return (
            <div className="station-summary" key={station.id}>
              <span className={'station-letter' + (station.id === nextStation?.id ? ' recommended' : '')}>{station.id.toUpperCase()}</span>
              <div><strong>{station.name}</strong><span>{station.detail}</span></div>
              <small className={full ? 'warn-text' : ''}>
                {full ? full + ' 桶满' : unknown ? unknown + ' 桶未知' : '可用'}
              </small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Cleaner({ state, connected, busy, onCollect }: {
  state: Snapshot | null; connected: boolean; busy: boolean; onCollect: Collect;
}) {
  const active = state?.tickets.filter((ticket) => ticket.status !== 'closed') ?? [];
  const next = active.find((ticket) => ticket.id === state?.recommendation);
  const nextBin = state?.bins.find((bin) => bin.id === next?.bin_id);
  const nextStation = state?.stations.find((station) => station.id === nextBin?.station_id);

  return (
    <div className="cleaner-grid">
      <div className="cleaner-left">
        <section className="next-panel" aria-labelledby="next-title">
          <div className="next-top"><Route size={19} /> <h2 id="next-title">下一站</h2></div>
          {next && nextStation && nextBin ? (
            <>
              <div className="next-place">
                <div><p>{nextStation.detail}</p><h3>{nextStation.name}</h3></div>
                <span className="next-letter" aria-hidden>{nextStation.id.toUpperCase()}</span>
              </div>
              <div className="next-meta">
                <span>{categories[nextBin.category].label}</span>
                <span><Clock3 size={15} /> 已等待 {waitLabel(next.opened_at)}</span>
              </div>
              <div className="next-bottom">
                <p>{primaryReason(next, active)}</p>
                <button className="light-button" onClick={() => onCollect(next.id)} disabled={busy || !connected}><Check size={17} /> 确认已清运</button>
              </div>
            </>
          ) : (
            <div className="next-empty">
              <Truck size={47} strokeWidth={1.25} />
              <h3>{connected ? '暂无清运任务' : '等待后端连接'}</h3>
              <p>{active.length > 0 ? '当前工单正在等待桶位重新上报。' : '收到满桶上报后，这里会显示建议处理的站点。'}</p>
            </div>
          )}
        </section>
        <section className="panel queue-panel" aria-labelledby="queue-title" data-testid="queue">
          <div className="panel-heading">
            <span className="section-icon"><ClipboardList size={21} /></span>
            <div><h2 id="queue-title">清运工单</h2><p>{active.length} 条进行中</p></div>
          </div>
          {active.length === 0 ? (
            <div className="queue-empty"><Check size={21} /> {connected ? '暂无进行中的工单' : '等待工单同步'}</div>
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
                      <strong>{station?.name} · {categories[bin.category].label}</strong>
                      <span>{ticketLabels[ticket.status]} · 等待 {waitLabel(ticket.opened_at)}</span>
                    </div>
                    {ticket.id === next?.id ? (
                      <span className="status-chip priority">优先</span>
                    ) : executable ? (
                      <button className="outline ticket-action" onClick={() => onCollect(ticket.id)} disabled={busy || !connected}>标记已清运</button>
                    ) : (
                      <span className={'status-chip ' + bin.status}>{binLabels[bin.status]}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {state && <CampusMap state={state} nextStation={nextStation} />}
    </div>
  );
}

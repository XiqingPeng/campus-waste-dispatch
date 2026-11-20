import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, MapPin } from 'lucide-react';
import { drawCampus, mapHeight, mapWidth, officialMap, stationLocations } from './campus-drawing';
import { binLabels, categories, categoryOrder, ticketLabels } from './domain';
import type { Snapshot, Station } from './domain';

const stationStatus = {
  available: '可投放',
  full: '有满桶',
  unknown: '有设备未知',
} as const;

export function CampusMap({ state, nextStation }: { state: Snapshot; nextStation?: Station }) {
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.setTransform(2, 0, 0, 2, 0, 0);
    drawCampus(context);
  }, []);

  const stations = state.stations.map((station) => {
    const bins = state.bins.filter((bin) => bin.station_id === station.id);
    const full = bins.filter((bin) => bin.status === 'full').length;
    const unknown = bins.filter((bin) => bin.status === 'unknown').length;
    const status = full ? 'full' : unknown ? 'unknown' : 'available';
    return { ...station, bins, full, unknown, status } as const;
  });
  const visible = onlyAlerts ? stations.filter((station) => station.status !== 'available') : stations;
  const selected = visible.find((station) => station.id === selectedId)
    ?? visible.find((station) => station.id === nextStation?.id) ?? visible[0];

  return (
    <section className="panel station-map-panel" aria-labelledby="map-title">
      <div className="panel-heading campus-map-heading">
        <span className="section-icon"><MapPin size={21} /></span>
        <div><h2 id="map-title">港科大（广州）校园点位图</h2><p>校园核心区 · {stations.length} 个模拟站点</p></div>
        <label className="map-filter"><input type="checkbox" checked={onlyAlerts} onChange={(event) => setOnlyAlerts(event.target.checked)} /> 只看异常</label>
      </div>
      <div className="station-map">
        <canvas ref={canvas} width={mapWidth * 2} height={mapHeight * 2} aria-hidden="true" />
        {visible.map((station) => {
          const location = stationLocations[station.id];
          if (!location) return null;
          const [x, y] = location;
          return (
            <button
              type="button"
              className={'map-point ' + station.status + (nextStation?.id === station.id ? ' recommended' : '')}
              key={station.id}
              style={{ left: x / mapWidth * 100 + '%', top: y / mapHeight * 100 + '%' }}
              aria-label={station.name + '，' + stationStatus[station.status]}
              aria-pressed={station.id === selected?.id}
              onClick={() => setSelectedId(station.id)}
            >
              <span>{station.id.toUpperCase()}</span><b>{station.id.toUpperCase()} 站</b>
            </button>
          );
        })}
        <span className="map-caption">校园示意图 · 非测绘比例</span>
      </div>
      <div className="map-footer">
        <div className="map-legend">
          {Object.entries(stationStatus).map(([status, text]) => (
            <span key={status}><i className={status} />{text}</span>
          ))}
        </div>
        <a href={officialMap} target="_blank" rel="noreferrer">校方地图 <ArrowUpRight size={13} /></a>
      </div>
      {selected ? (
        <div className="map-details" aria-live="polite">
          <div className="map-details-title">
            <div><strong>{selected.name}</strong><span>{selected.detail}</span></div>
            {selected.id === nextStation?.id && <span className="status-chip priority">推荐下一站</span>}
          </div>
          <ul className="map-bin-list">
            {categoryOrder.map((category) => {
              const bin = selected.bins.find((item) => item.category === category);
              if (!bin) return null;
              const ticket = state.tickets.find((item) => item.bin_id === bin.id && item.status !== 'closed');
              return (
                <li key={bin.id}>
                  <strong>{categories[category].label}</strong>
                  <span className={bin.status}>{ticket ? ticketLabels[ticket.status] : binLabels[bin.status]}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : <p className="map-no-results" role="status">当前没有异常站点。</p>}
    </section>
  );
}

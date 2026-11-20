import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { drawCampus, mapHeight, mapWidth, officialMap, stationLocations } from './campus-drawing';
import { binLabels, categories, categoryOrder, ticketLabels } from './domain';
import type { Snapshot, Station } from './domain';
import { useLocale } from './locale';

const stationStatus = {
  available: '可投放',
  full: '有满桶',
  unknown: '有设备未知',
} as const;

export function CampusMap({ state, nextStation }: { state: Snapshot; nextStation?: Station }) {
  const { t, text } = useLocale();
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.setTransform(2, 0, 0, 2, 0, 0);
    drawCampus(context, t);
  }, [t]);

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
        <div><h2 id="map-title">{t('港科大（广州）校园点位图')}</h2><p>{t('{count} 个投放站点', { count: stations.length })}</p></div>
        <label className="map-filter"><input type="checkbox" checked={onlyAlerts} onChange={(event) => setOnlyAlerts(event.target.checked)} /> {t('只看异常')}</label>
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
              aria-label={text(station.name) + ', ' + t(stationStatus[station.status])}
              aria-pressed={station.id === selected?.id}
              onClick={() => setSelectedId(station.id)}
            >
              <span>{station.id.toUpperCase()}</span><b>{t('{station} 站', { station: station.id.toUpperCase() })}</b>
            </button>
          );
        })}
        <span className="map-caption">{t('校园示意图（非测绘比例）')}</span>
      </div>
      <div className="map-footer">
        <div className="map-legend">
          {Object.entries(stationStatus).map(([status, label]) => (
            <span key={status}><i className={status} />{t(label)}</span>
          ))}
        </div>
        <a href={officialMap} target="_blank" rel="noreferrer">{t('校方地图')} <ArrowUpRight size={13} /></a>
      </div>
      {selected ? (
        <div className="map-details" aria-live="polite">
          <div className="map-details-title">
            <div><strong>{text(selected.name)}</strong><span>{text(selected.detail)}</span></div>
            {selected.id === nextStation?.id && <span className="status-chip priority">{t('推荐下一站')}</span>}
          </div>
          <ul className="map-bin-list">
            {categoryOrder.map((category) => {
              const bin = selected.bins.find((item) => item.category === category);
              if (!bin) return null;
              const ticket = state.tickets.find((item) => item.bin_id === bin.id && item.status !== 'closed');
              return (
                <li key={bin.id}>
                  <strong>{t(categories[category].label)}</strong>
                  <span className={bin.status}>{t(ticket ? ticketLabels[ticket.status] : binLabels[bin.status])}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : <p className="map-no-results" role="status">{t('当前没有异常站点。')}</p>}
    </section>
  );
}

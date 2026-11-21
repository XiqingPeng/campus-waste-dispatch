import { useState } from 'react';
import { Minus, Plus, MapPin } from 'lucide-react';
import type { Snapshot } from './domain';
import { binLabels, ticketLabels, categories, categoryOrder } from './domain';
import { deviceOnline, overdue, stationStatus } from './cleaner-model';
import { useLocale } from './locale';

// Crop the presentation only; catalog coordinates stay normalized to the full base map.
const campusView = { x: 350, y: 30, width: 840, height: 850 };
const baseMap = { width: 1400, height: 950 };

export function CollectionMap({
  state,
  now,
  zone,
  selectedId,
  onSelect,
}: {
  state: Snapshot;
  now: number;
  zone: string;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t, text, language } = useLocale();
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [zoom, setZoom] = useState(1);
  const selected = state.stations.find((point) => point.id === selectedId);
  const time = (value: number | null | undefined) =>
    value == null
      ? '—'
      : new Intl.DateTimeFormat(language, {
          timeZone: 'Asia/Shanghai',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(value);
  return (
    <section className="panel collection-map-panel" aria-labelledby="map-title">
      <div className="panel-heading campus-map-heading">
        <div>
          <h2 id="map-title">{t('港科大（广州）校园点位图')}</h2>
          <p>{t('{count} 个站点 · 每站四类垃圾桶', { count: state.stations.length })}</p>
        </div>
        <label className="map-filter">
          <input
            type="checkbox"
            checked={onlyAlerts}
            onChange={(event) => setOnlyAlerts(event.target.checked)}
          />
          {t('只看异常')}
        </label>
      </div>
      <div className="collection-map-tools">
        <span>{t('可横向滑动地图，或缩放后选择点位。')}</span>
        <button
          className="icon-button"
          aria-label={t('缩小地图')}
          disabled={zoom === 1}
          onClick={() => setZoom(Math.max(1, zoom - 0.5))}
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          className="icon-button"
          aria-label={t('放大地图')}
          disabled={zoom === 2}
          onClick={() => setZoom(Math.min(2, zoom + 0.5))}
        >
          <Plus size={16} />
        </button>
      </div>
      <div
        className="collection-map-scroll"
        tabIndex={0}
        role="region"
        aria-label={t('校园点位图可滚动区域')}
      >
        <div
          className="collection-map-surface"
          style={{
            width: `${zoom * 100}%`,
            minWidth: 560 * zoom,
            aspectRatio: `${campusView.width} / ${campusView.height}`,
          }}
        >
          <svg
            viewBox={`${campusView.x} ${campusView.y} ${campusView.width} ${campusView.height}`}
            aria-hidden="true"
          >
            <image
              href="/maps/collection-campus.svg"
              width={baseMap.width}
              height={baseMap.height}
            />
          </svg>
          {state.stations.map((point) => {
            const status = stationStatus(state, point.id, now);
            const label = t(({ overdue: '超时待处理', full: '待清运', verify: '待传感器确认', unknown: '离线或未知', available: '未满' } as const)[status]);
            const dim =
              (zone !== 'all' && point.zone !== zone) ||
              (onlyAlerts && status === 'available');
            return (
              <button
                key={point.id}
                type="button"
                className={'collection-point ' + status + (dim ? ' dim' : '')}
                style={{
                  left: `${(((point.map_x ?? 0) * baseMap.width - campusView.x) / campusView.width) * 100}%`,
                  top: `${(((point.map_y ?? 0) * baseMap.height - campusView.y) / campusView.height) * 100}%`,
                }}
                aria-label={`${point.id} ${text(point.name)} · ${label}`}
                aria-pressed={selectedId === point.id}
                title={`${point.id} ${text(point.name)} · ${label}`}
                onClick={() => onSelect(point.id)}
              >
                <span className="point-dot" />
                <span className="point-label">{point.id}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="collection-map-footer">
        <div className="collection-legend">
          {(['available', 'full', 'overdue', 'verify', 'unknown'] as const).map(
            (key, i) => (
              <span key={key}>
                <i className={key} />
                {t(
                  (
                    [
                      '未满',
                      '待清运',
                      '超时待处理',
                      '待传感器确认',
                      '离线或未知',
                    ] as const
                  )[i],
                )}
              </span>
            ),
          )}
        </div>
        <details className="map-credit">
          <summary>{t('地图信息')}</summary>
          <p>
            ©{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              OpenStreetMap contributors
            </a>{' '}
            · ODbL
          </p>
        </details>
      </div>
      <div
        className={selected ? 'collection-point-detail' : undefined}
        aria-live="polite"
      >
        {selected ? (
          <>
            <div className="detail-eyebrow">
              {selected.id} · {text(selected.zone ?? '')}
            </div>
            <strong>
              <MapPin size={17} />
              {text(selected.name)}
            </strong>
            <div className="station-bin-grid">
              {categoryOrder.map(category => {
                const bin = state.bins.find(item => item.station_id === selected.id && item.category === category);
                const ticket = bin && state.tickets.find(item => item.bin_id === bin.id && item.status !== 'closed');
                const Icon = categories[category].icon;
                return <article className={'station-bin-card ' + category} key={category}>
                  <h3><Icon size={17} />{t(categories[category].label)}</h3>
                  <small>{bin?.id ?? '—'}</small>
                  <div className="detail-facts"><span>{t('设备状态')}：{t(binLabels[bin?.status ?? 'unknown'])}</span><span>{t(bin && deviceOnline(bin, now) ? '设备在线' : '离线或未知')}</span></div>
                  <p>{t('最近有效上报')}：{time(bin?.received_at)}</p>
                  <p>{ticket ? `#${ticket.id} · ${t(overdue(ticket, now) ? '超时待处理' : ticketLabels[ticket.status])}` : t('暂无进行中的工单')}</p>
                </article>;
              })}
            </div>
            <button className="outline" onClick={() => onSelect('all')}>
              {t('取消点位筛选')}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

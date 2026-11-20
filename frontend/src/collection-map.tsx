import { useState } from 'react';
import { Minus, Plus, MapPin } from 'lucide-react';
import type { Snapshot } from './domain';
import { binLabels, ticketLabels } from './domain';
import { deviceOnline, overdue } from './cleaner-model';
import { useLocale } from './locale';

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
  const bin = state.bins.find((bin) => bin.id === selectedId);
  const ticket = state.tickets.find(
    (ticket) => ticket.bin_id === selectedId && ticket.status !== 'closed',
  );
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
          <p>{t('50 个模拟点位 · 每点一个生活垃圾桶')}</p>
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
          style={{ width: `${zoom * 100}%`, minWidth: 820 * zoom }}
        >
          <img src="/maps/collection-campus.svg" alt="" />
          {state.stations.map((point) => {
            const device = state.bins.find((bin) => bin.id === point.id);
            const active = state.tickets.find(
              (ticket) =>
                ticket.bin_id === point.id && ticket.status !== 'closed',
            );
            const online = device && deviceOnline(device, now);
            const status =
              active && overdue(active, now)
                ? 'overdue'
                : active?.status === 'awaiting_verify'
                  ? 'verify'
                  : active
                    ? 'full'
                    : !online
                      ? 'unknown'
                      : 'available';
            const label = active
              ? t(
                  overdue(active, now)
                    ? '超时待处理'
                    : ticketLabels[active.status],
                )
              : t(!online ? '离线或未知' : '未满');
            const dim =
              (zone !== 'all' && point.zone !== zone) ||
              (onlyAlerts && status === 'available');
            return (
              <button
                key={point.id}
                type="button"
                className={'collection-point ' + status + (dim ? ' dim' : '')}
                style={{
                  left: `${(point.map_x ?? 0) * 100}%`,
                  top: `${(point.map_y ?? 0) * 100}%`,
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
      <div className="collection-point-detail" aria-live="polite">
        {selected && bin ? (
          <>
            <div className="detail-eyebrow">
              {selected.id} · {text(selected.zone ?? '')}
            </div>
            <strong>
              <MapPin size={17} />
              {text(selected.name)}
            </strong>
            <div className="detail-facts">
              <span>
                {t('设备状态')}：{t(binLabels[bin.status])}
              </span>
              <span>
                {t(deviceOnline(bin, now) ? '设备在线' : '离线或未知')}
              </span>
              <span>
                {t('最近有效上报')}：{time(bin.received_at)}
              </span>
            </div>
            {ticket && (
              <div className="detail-facts">
                <span>
                  #{ticket.id} · {t(ticketLabels[ticket.status])}
                </span>
                <span>
                  {t('首次检测满桶')}：{time(ticket.opened_at)}
                </span>
              </div>
            )}
            <button className="outline" onClick={() => onSelect('all')}>
              {t('取消点位筛选')}
            </button>
          </>
        ) : (
          <p>{t('点击地图点位，查看编号、设备状态和关联工单。')}</p>
        )}
      </div>
      <div className="map-credit">
        ©{' '}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          OpenStreetMap contributors
        </a>{' '}
        · ODbL · {t('示意点位，不代表实际部署')}
      </div>
    </section>
  );
}

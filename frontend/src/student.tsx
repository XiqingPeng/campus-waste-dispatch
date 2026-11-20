import { ArrowUpRight, CircleHelp, Clock3, Lightbulb, MapPin, SignpostBig } from 'lucide-react';
import { useState } from 'react';
import { Capture } from './capture';
import { availability, binLabels, categories, categoryOrder } from './domain';
import type { Result, Snapshot, Station } from './domain';

export function Student({ state, station, visible, connected }: {
  state: Snapshot | null; station: Station | undefined; visible: boolean; connected: boolean;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const guidance = result?.category && state && station && connected
    ? availability(state, station, result.category)
    : null;
  const TargetIcon = result?.category ? categories[result.category].icon : null;
  const local = guidance?.local?.status === 'available';
  const alternate = guidance?.alternate;
  const stationBins = state?.bins.filter((bin) => bin.station_id === station?.id) ?? [];
  const decisionStyle = local ? 'positive' : alternate ? 'redirect' : 'caution';

  return (
    <div className="student-grid">
      <Capture onResult={setResult} visible={visible} />
      <div className="student-right">
        <section className="panel guidance-panel" aria-labelledby="guidance-title">
          <div className="panel-heading">
            <span className="section-icon"><SignpostBig size={21} /></span>
            <div>
              <h2 id="guidance-title">投放指引</h2>
              <p>{station ? station.name + '（' + station.detail + '）' : '等待站点连接'}</p>
            </div>
            {result && <span className="source-label">{result.source === 'replay' ? '样例回放' : 'JEV 识别'}</span>}
          </div>
          <div className="decision-slot" aria-live="polite">
            {!result ? (
              <div className="decision idle">
                <span className="decision-icon"><Lightbulb size={26} /></span>
                <span className="decision-overline">等待物品识别</span>
                <h3>先识别，再投放</h3>
                <p>识别后查看桶位指引。</p>
              </div>
            ) : (
              <div className={'decision ' + decisionStyle}>
                <span className="decision-icon">
                  {local && TargetIcon ? <TargetIcon size={29} /> : alternate ? <ArrowUpRight size={29} /> : result.category ? <Clock3 size={27} /> : <CircleHelp size={27} />}
                </span>
                <span className="decision-overline">{result.item}{result.category && '（' + categories[result.category].label + '）'}</span>
                <h3>
                  {local && result.category ? '请投' + categories[result.category].label
                    : alternate ? '请前往 ' + alternate.name
                    : result.category ? '暂不可投放'
                    : '需要进一步确认'}
                </h3>
                <p>
                  {local ? '请将物品投进亮灯的桶口。'
                    : alternate ? (guidance?.local?.status === 'full' ? '本站同类桶已满。' : '本站同类桶暂不可用。') + ' ' + alternate.detail + '的同类桶可用。'
                    : result.category ? (connected ? '附近没有可用的同类桶，请稍后再投。' : '暂时无法确认桶位，请稍后再试。')
                    : result.question || '请把物品单独摆放，拍清楚后再识别。'}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="panel bins-panel" aria-labelledby="bins-title">
          <div className="panel-heading">
            <span className="section-icon"><Lightbulb size={21} /></span>
            <div>
              <h2 id="bins-title">本站桶位</h2>
              <p>桶口灯光为界面模拟</p>
            </div>
            <span className="source-label"><MapPin size={13} /> {station?.name ?? '本站'}</span>
          </div>
          <div className="bins-grid">
            {categoryOrder.map((category) => {
              const Icon = categories[category].icon;
              const bin = stationBins.find((item) => item.category === category);
              const status = connected ? bin?.status ?? 'unknown' : 'unknown';
              const lit = Boolean(local && result?.category === category);
              return (
                <div className={'bin-card ' + category + (lit ? ' lit' : '')} key={category} data-category={category} data-lit={lit} data-testid={'bin-' + category}>
                  <div className="bin-led" aria-label={lit ? '已亮灯' : '未亮灯'} />
                  <div className="bin-icon"><Icon size={23} strokeWidth={1.6} /></div>
                  <strong>{categories[category].label}</strong>
                  <span className={'bin-status ' + status}>{lit ? '投这里' : binLabels[status]}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

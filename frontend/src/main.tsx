import { Activity, ArrowDown, CircleAlert, MapPin, Recycle, RotateCcw, Settings2, Trash2, Truck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { errorText, useCampusState } from './api';
import { Cleaner } from './cleaner';
import { binLabels, categories, categoryOrder } from './domain';
import type { BinStatus, Category, Snapshot } from './domain';
import { Student } from './student';
import './style.css';

type View = 'student' | 'cleaner';
type Mutation = (path: string, payload?: unknown) => Promise<Snapshot>;
function currentView(): View {
  return window.location.hash === '#cleaner' ? 'cleaner' : 'student';
}

function Simulator({ dialog, state, update, disabled, onReset }: {
  dialog: React.RefObject<HTMLDialogElement | null>;
  state: Snapshot | null;
  update: Mutation;
  disabled: boolean;
  onReset: () => void;
}) {
  const [stationId, setStationId] = useState('a');
  const [category, setCategory] = useState<Category>('recycle');
  const [localMessage, setLocalMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [lastFull, setLastFull] = useState('');
  const station = state?.stations.find((item) => item.id === stationId);
  const bin = state?.bins.find((item) => item.station_id === stationId && item.category === category);

  async function report(status: BinStatus) {
    if (!bin || !station) return;
    setLocalMessage(null);
    try {
      await update('/api/sensor', {
        event_id: globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random().toString(36).slice(2),
        bin_id: bin.id,
        status,
        observed_at: Math.max(Date.now(), (bin.observed_at ?? 0) + 1),
      });
      if (status === 'full') setLastFull(bin.id);
      setLocalMessage({ text: '已上报' + station.name + '的' + categories[category].label + '桶，状态为' + binLabels[status] + '。', error: false });
    } catch (cause) {
      setLocalMessage({ text: errorText(cause), error: true });
    }
  }

  async function reset() {
    setLocalMessage(null);
    try {
      await update('/api/demo/reset');
      setStationId('a');
      setCategory('recycle');
      setLastFull('');
      setLocalMessage({ text: '演示数据已复位。', error: false });
      onReset();
    } catch (cause) {
      setLocalMessage({ text: errorText(cause), error: true });
    }
  }

  return (
    <dialog ref={dialog} className="sim-dialog" aria-labelledby="sim-title" data-testid="simulator" onClick={(event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    }}>
      <div className="sim-wrap">
        <div className="sim-heading">
          <span className="section-icon"><Settings2 size={22} /></span>
          <div><h2 id="sim-title">设备模拟器</h2><p>向后端上报模拟红外状态</p></div>
          <button className="icon-button" aria-label="关闭模拟器" onClick={() => dialog.current?.close()}><X size={22} /></button>
        </div>
        <div className="sim-fields">
          <label>模拟站点<select value={stationId} onChange={(event) => setStationId(event.currentTarget.value)}>
            {state?.stations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label>模拟桶位<select value={category} onChange={(event) => setCategory(event.currentTarget.value as Category)}>
            {categoryOrder.map((key) => <option key={key} value={key}>{categories[key].label}</option>)}
          </select></label>
        </div>
        <div className="sim-observation">
          <span>后端当前状态</span>
          <strong className={bin?.status === 'full' ? 'warn-text' : ''}>{bin ? binLabels[bin.status] : '未知'}</strong>
        </div>
        <div className="sim-actions">
          <button className="primary" onClick={() => void report('full')} disabled={disabled || !bin}><Activity size={18} /> 上报已满</button>
          <button className="outline" onClick={() => void report('full')} disabled={disabled || !bin || lastFull !== bin.id}>再次上报已满</button>
          <button className="outline" onClick={() => void report('available')} disabled={disabled || !bin}>上报未满</button>
          <button className="outline" onClick={() => void report('unknown')} disabled={disabled || !bin}>模拟设备离线</button>
        </div>
        <div className={'sim-feedback' + (localMessage?.error ? ' error' : '')} role="status">{localMessage?.text}</div>
        <div className="sim-footer">
          <button className="outline" onClick={() => void reset()} disabled={disabled}><RotateCcw size={16} /> 重置演示数据</button>
          <p>清空演示工单，恢复全部示范桶位。</p>
        </div>
      </div>
    </dialog>
  );
}

function App() {
  const [view, setView] = useState(currentView);
  const [stationId, setStationId] = useState('a');
  const [notice, setNotice] = useState('');
  const [studentVersion, setStudentVersion] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const { snapshot, connected, busy, loadError, update } = useCampusState();
  const station = snapshot?.stations.find((item) => item.id === stationId) ?? snapshot?.stations[0];

  useEffect(() => {
    const onHash = () => { setView(currentView()); setNotice(''); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  async function collect(id: number) {
    setNotice('');
    try {
      await update('/api/tickets/' + id + '/collect');
    } catch (cause) {
      setNotice(errorText(cause));
    }
  }

  return (
    <>
      <a className="skip" href="#main-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById('main-content')?.focus();
      }}>跳到主要区域</a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark"><Recycle size={24} strokeWidth={2.1} /></span>
            <div><strong>Campus Loop</strong><span>校园垃圾分类与清运</span></div>
          </div>
          <nav className="nav-tabs" aria-label="页面切换">
            <a href="#student" aria-current={view === 'student' ? 'page' : undefined}><Trash2 size={17} /> 学生投放</a>
            <a href="#cleaner" aria-current={view === 'cleaner' ? 'page' : undefined}><Truck size={18} /> 保洁工作台</a>
          </nav>
          <button className="outline sim-trigger" onClick={() => dialog.current?.showModal()}>
            <Settings2 size={17} /> <span>设备模拟器</span>
          </button>
        </div>
      </header>

      <main className="layout" id="main-content" tabIndex={-1}>
        <section className="page-heading" aria-labelledby="page-title">
          <div>
            <div className="location"><MapPin size={16} /> 宿舍区 <span>示范站点</span></div>
            <h1 id="page-title">{view === 'student' ? '校园分类投放' : '保洁工作台'}</h1>
            <p>{view === 'student' ? '识别手中的物品，获取当前可用的投放位置。' : '查看满桶工单与推荐清运顺序。'}</p>
          </div>
          <div className="page-tools">
            <span className={'connection' + (connected ? ' online' : '')} title={loadError || '桶位与工单实时同步'}>
              <span /> {connected ? '状态已同步' : loadError ? '连接中断' : '正在连接'}
            </span>
            {view === 'student' && (
              <label className="station-select">
                <span className="sr-only">当前投放站点</span>
                <MapPin size={17} aria-hidden />
                <select value={station?.id ?? stationId} onChange={(event) => setStationId(event.currentTarget.value)} disabled={!station}>
                  {!station && <option value={stationId}>选择站点</option>}
                  {snapshot?.stations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <ArrowDown className="select-arrow" size={14} aria-hidden />
              </label>
            )}
          </div>
        </section>

        {loadError && <div className="callout error connection-error" role="status"><CircleAlert size={17} /><span>{loadError} 桶位状态待重新连接确认。</span></div>}
        {notice && <div className="callout error connection-error" role="status"><CircleAlert size={17} /><span>{notice}</span></div>}
        <div hidden={view !== 'student'}>
          <Student key={studentVersion} state={snapshot} station={station} visible={view === 'student'} connected={connected} />
        </div>
        {view === 'cleaner' && <Cleaner state={snapshot} connected={connected} busy={busy} onCollect={(id) => void collect(id)} />}
      </main>

      <Simulator dialog={dialog} state={snapshot} update={update} disabled={busy || !connected} onReset={() => {
        setStudentVersion((version) => version + 1);
        setStationId('a');
        setNotice('');
      }} />
      <footer className="footer">课程原型使用模拟站点、红外状态和指示灯。</footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

import { Activity, ArrowDown, CircleAlert, Globe, KeyRound, LogOut, MapPin, Recycle, RotateCcw, Settings2, Trash2, Truck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { accessRequiredEvent, errorText, request, useCampusState } from './api';
import type { AccessStatus } from './api';
import { Cleaner } from './cleaner';
import { binLabels, categories, categoryOrder } from './domain';
import type { BinStatus, Category, Snapshot, Station } from './domain';
import { GroupAccess } from './group-access';
import { Student } from './student';
import { LocaleProvider, useLocale } from './locale';
import './style.css';

type View = 'student' | 'cleaner';
type Mutation = (path: string, payload?: unknown) => Promise<Snapshot>;
type SimulatorMessage =
  | { kind: 'reported'; station: Station; category: Category; status: BinStatus }
  | { kind: 'reset' }
  | { kind: 'error'; message: string };
function currentView(): View {
  return window.location.hash === '#cleaner' ? 'cleaner' : 'student';
}

function Simulator({ dialog, state, update, disabled, onReset, onLogout }: {
  dialog: React.RefObject<HTMLDialogElement | null>;
  state: Snapshot | null;
  update: Mutation;
  disabled: boolean;
  onReset: () => void;
  onLogout?: () => void;
}) {
  const [stationId, setStationId] = useState('a');
  const [category, setCategory] = useState<Category>('recycle');
  const { t, text } = useLocale();
  const [localMessage, setLocalMessage] = useState<SimulatorMessage | null>(null);
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
      setLocalMessage({ kind: 'reported', station, category, status });
    } catch (cause) {
      setLocalMessage({ kind: 'error', message: errorText(cause) });
    }
  }

  async function reset() {
    setLocalMessage(null);
    try {
      await update('/api/demo/reset');
      setStationId('a');
      setCategory('recycle');
      setLastFull('');
      setLocalMessage({ kind: 'reset' });
      onReset();
    } catch (cause) {
      setLocalMessage({ kind: 'error', message: errorText(cause) });
    }
  }

  const feedback = localMessage?.kind === 'reported'
    ? t('已上报{station}的{category}桶，状态为{status}。', {
        station: text(localMessage.station.name),
        category: t(categories[localMessage.category].label),
        status: t(binLabels[localMessage.status]),
      })
    : localMessage?.kind === 'reset' ? t('演示数据已复位。') : text(localMessage?.message ?? '');

  return (
    <dialog ref={dialog} className="sim-dialog" aria-labelledby="sim-title" data-testid="simulator" onClick={(event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    }}>
      <div className="sim-wrap">
        <div className="sim-heading">
          <span className="section-icon"><Settings2 size={22} /></span>
          <div><h2 id="sim-title">{t('设备模拟器')}</h2><p>{t('向后端上报模拟红外状态')}</p></div>
          <button className="icon-button" aria-label={t('关闭模拟器')} onClick={() => dialog.current?.close()}><X size={22} /></button>
        </div>
        <div className="sim-fields">
          <label>{t('模拟站点')}<select value={stationId} onChange={(event) => setStationId(event.currentTarget.value)}>
            {state?.stations.map((item) => <option key={item.id} value={item.id}>{text(item.name)}</option>)}
          </select></label>
          <label>{t('模拟桶位')}<select value={category} onChange={(event) => setCategory(event.currentTarget.value as Category)}>
            {categoryOrder.map((key) => <option key={key} value={key}>{t(categories[key].label)}</option>)}
          </select></label>
        </div>
        <div className="sim-observation">
          <span>{t('后端当前状态')}</span>
          <strong className={bin?.status === 'full' ? 'warn-text' : ''}>{t(binLabels[bin?.status ?? 'unknown'])}</strong>
        </div>
        <div className="sim-actions">
          <button className="primary" onClick={() => void report('full')} disabled={disabled || !bin}><Activity size={18} /> {t('上报已满')}</button>
          <button className="outline" onClick={() => void report('full')} disabled={disabled || !bin || lastFull !== bin.id}>{t('再次上报已满')}</button>
          <button className="outline" onClick={() => void report('available')} disabled={disabled || !bin}>{t('上报未满')}</button>
          <button className="outline" onClick={() => void report('unknown')} disabled={disabled || !bin}>{t('模拟设备离线')}</button>
        </div>
        <div className={'sim-feedback' + (localMessage?.kind === 'error' ? ' error' : '')} role="status">{feedback}</div>
        <div className="sim-footer">
          <button className="outline" onClick={() => void reset()} disabled={disabled}><RotateCcw size={16} /> {t('重置演示数据')}</button>
          <p>{t('清空演示工单，恢复全部示范桶位。')}</p>
          {onLogout && <button className="outline" onClick={onLogout}><LogOut size={16} /> {t('退出组内访问')}</button>}
        </div>
      </div>
    </dialog>
  );
}

function App() {
  const { language, setLanguage, t, text } = useLocale();
  const [view, setView] = useState(currentView);
  const [stationId, setStationId] = useState('a');
  const [notice, setNotice] = useState('');
  const [studentVersion, setStudentVersion] = useState(0);
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const accessDialog = useRef<HTMLDialogElement>(null);
  const { snapshot, connected, busy, loadError, update } = useCampusState();
  const station = snapshot?.stations.find((item) => item.id === stationId) ?? snapshot?.stations[0];
  const locked = access?.required && !access.signed_in;

  useEffect(() => {
    const onHash = () => {
      setView(currentView());
      setNotice('');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let mounted = true;
    void request<AccessStatus>('/api/access').then((status) => {
      if (mounted) setAccess((current) => current ?? status);
    }).catch(() => {});
    const showAccess = () => {
      setAccess({ required: true, signed_in: false });
      dialog.current?.close();
      accessDialog.current?.showModal();
    };
    window.addEventListener(accessRequiredEvent, showAccess);
    return () => {
      mounted = false;
      window.removeEventListener(accessRequiredEvent, showAccess);
    };
  }, []);

  async function logout() {
    try {
      setAccess(await request<AccessStatus>('/api/access/logout', {}));
      dialog.current?.close();
    } catch (cause) {
      dialog.current?.close();
      setNotice(errorText(cause));
    }
  }

  async function collect(id: number) {
    setNotice('');
    if (locked) {
      accessDialog.current?.showModal();
      return;
    }
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
      }}>{t('跳到主要区域')}</a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark"><Recycle size={24} strokeWidth={2.1} /></span>
            <div><strong>Campus Loop</strong><span>{t('校园垃圾分类与清运')}</span></div>
          </div>
          <nav className="nav-tabs" aria-label={t('页面切换')}>
            <a href="#student" aria-current={view === 'student' ? 'page' : undefined}><Trash2 size={17} /> {t('学生投放')}</a>
            <a href="#cleaner" aria-current={view === 'cleaner' ? 'page' : undefined}><Truck size={18} /> {t('保洁工作台')}</a>
          </nav>
          <div className="topbar-actions">
            <label className="language-select">
              <Globe size={16} aria-hidden />
              <span className="sr-only">{t('语言')}</span>
              <select value={language} onChange={(event) => setLanguage(event.currentTarget.value === 'en' ? 'en' : 'zh-CN')}>
                <option value="zh-CN" lang="zh-CN">中文</option>
                <option value="en" lang="en">English</option>
              </select>
              <ArrowDown className="select-arrow" size={12} aria-hidden />
            </label>
            <button className="outline sim-trigger" onClick={() => (locked ? accessDialog : dialog).current?.showModal()}>
              {locked ? <KeyRound size={17} /> : <Settings2 size={17} />} <span>{t(locked ? '组内登录' : '设备模拟器')}</span>
            </button>
          </div>
        </div>
      </header>

      <main className={view === 'cleaner' ? 'layout cleaner-layout' : 'layout'} id="main-content" tabIndex={-1}>
        <section className="page-heading" aria-labelledby="page-title">
          <div>
            <div className="location"><MapPin size={16} /> {t('宿舍区')}</div>
            <h1 id="page-title">{t(view === 'student' ? '校园分类投放' : '保洁工作台')}</h1>
            <p>{t(view === 'student' ? '识别手中的物品，获取当前可用的投放位置。' : '查看满桶工单与推荐清运顺序。')}</p>
          </div>
          <div className="page-tools">
            <span className={'connection' + (connected ? ' online' : '')} title={loadError ? text(loadError) : t('桶位与工单实时同步')}>
              <span /> {t(connected ? '状态已同步' : loadError ? '连接中断' : '正在连接')}
            </span>
            {view === 'student' && (
              <label className="station-select">
                <span className="sr-only">{t('当前投放站点')}</span>
                <MapPin size={17} aria-hidden />
                <select value={station?.id ?? stationId} onChange={(event) => setStationId(event.currentTarget.value)} disabled={!station}>
                  {!station && <option value={stationId}>{t('选择站点')}</option>}
                  {snapshot?.stations.map((item) => <option key={item.id} value={item.id}>{text(item.name)}</option>)}
                </select>
                <ArrowDown className="select-arrow" size={14} aria-hidden />
              </label>
            )}
          </div>
        </section>

        {loadError && <div className="callout error connection-error" role="status"><CircleAlert size={17} /><span>{text(loadError)} {t('桶位状态待重新连接确认。')}</span></div>}
        {notice && <div className="callout error connection-error" role="status"><CircleAlert size={17} /><span>{text(notice)}</span></div>}
        <div hidden={view !== 'student'}>
          <Student key={studentVersion} state={snapshot} station={station} visible={view === 'student'} connected={connected} />
        </div>
        {view === 'cleaner' && <Cleaner state={snapshot} connected={connected} busy={busy} onCollect={(id) => void collect(id)} />}
      </main>

      <GroupAccess dialog={accessDialog} onLogin={setAccess} />
      <Simulator dialog={dialog} state={snapshot} update={update} disabled={busy || !connected}
        onLogout={access?.required && access.signed_in ? () => void logout() : undefined} onReset={() => {
        setStudentVersion((version) => version + 1);
        setStationId('a');
        setNotice('');
      }} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<LocaleProvider><App /></LocaleProvider>);

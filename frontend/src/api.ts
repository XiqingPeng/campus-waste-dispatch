import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from './domain';

export async function request<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(24_000),
    ...(payload === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  });

  if (!response.ok) {
    const info = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(info.error || '服务暂时不可用，请重试。');
  }
  return response.json() as Promise<T>;
}

export function errorText(error: unknown) {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '请求超时，请重试。';
  if (error instanceof TypeError) return '连接失败，请检查后端服务。';
  return error instanceof Error ? error.message : '服务暂时不可用，请重试。';
}

async function requestSnapshot(path: string, payload?: unknown): Promise<Snapshot> {
  const snapshot = await request<Snapshot>(path, payload);
  return {
    ...snapshot,
    // Preview instances using the previous backend still include a separator in station details.
    stations: snapshot.stations.map((station) => ({
      ...station,
      detail: station.detail.replace(/\s*\u00b7\s*/g, ''),
    })),
  };
}

export function useCampusState() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const updating = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const version = epoch.current;
      if (!updating.current) {
        try {
          const data = await requestSnapshot('/api/state');
          if (alive && epoch.current === version) {
            setSnapshot(data);
            setConnected(true);
            setLoadError('');
          }
        } catch (error) {
          if (alive && epoch.current === version) {
            setConnected(false);
            setLoadError(errorText(error));
          }
        }
      }
      if (alive) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const update = useCallback(async (path: string, payload: unknown = {}) => {
    if (updating.current) throw new Error('正在处理上一条指令，请稍候。');
    updating.current = true;
    epoch.current += 1;
    setBusy(true);
    try {
      const data = await requestSnapshot(path, payload);
      setSnapshot(data);
      setConnected(true);
      setLoadError('');
      return data;
    } finally {
      updating.current = false;
      setBusy(false);
    }
  }, []);

  return { snapshot, busy, connected, loadError, update };
}

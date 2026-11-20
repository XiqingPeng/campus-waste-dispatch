import { Battery, Coffee, Recycle, Trash2 } from 'lucide-react';

export const categories = {
  recycle: { label: '可回收物', icon: Recycle, examples: '空瓶、纸板' },
  food: { label: '厨余垃圾', icon: Coffee, examples: '果皮、剩饭' },
  residual: { label: '其他垃圾', icon: Trash2, examples: '纸巾、污损包装' },
  hazard: { label: '有害垃圾', icon: Battery, examples: '废灯管、废药品' },
} as const;

export type Category = keyof typeof categories;
export const categoryOrder = Object.keys(categories) as Category[];

export const samples = {
  bottle: { label: '空饮料瓶', category: 'recycle', image: '/samples/bottle.jpg' },
  cup: { label: '带盖饮料杯', category: 'residual' },
  tissue: { label: '用过的纸巾', category: 'residual' },
  banana: { label: '香蕉皮', category: 'food' },
} as const;

export type Sample = keyof typeof samples;
export const sampleKeys = Object.keys(samples) as Sample[];

export type BinStatus = 'available' | 'full' | 'unknown';
export type TicketStatus = 'pending' | 'awaiting_verify' | 'needs_review' | 'closed';

export const binLabels: Record<BinStatus, string> = { available: '可投放', full: '已满', unknown: '未知' };
export const ticketLabels: Record<TicketStatus, string> = {
  pending: '待清运',
  awaiting_verify: '待传感器确认',
  needs_review: '仍报满，待复核',
  closed: '已关闭',
};

export type Bin = { id: string; station_id: string; category: Category; status: BinStatus; observed_at: number | null };
export type Ticket = { id: number; bin_id: string; status: TicketStatus; opened_at: number };
export type Station = { id: string; name: string; detail: string; x: number; y: number };
export type Snapshot = { bins: Bin[]; tickets: Ticket[]; stations: Station[]; recommendation: number | null };
export type Result = { item: string; category: Category | null; question: string | null; source: 'jev' | 'replay' };

export function availability(state: Snapshot, station: Station, category: Category) {
  const bins = state.bins.filter((bin) => bin.category === category);
  const local = bins.find((bin) => bin.station_id === station.id);
  if (local?.status === 'available') return { local, alternate: null };
  const candidates = state.stations.filter((candidate) =>
    bins.some((bin) => bin.station_id === candidate.id && bin.status === 'available'),
  );
  const distance = (candidate: Station) => Math.hypot(candidate.x - station.x, candidate.y - station.y);
  candidates.sort((left, right) => distance(left) - distance(right) || left.id.localeCompare(right.id));
  return { local, alternate: candidates[0] ?? null };
}

export function waitLabel(openedAt: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - openedAt) / 60_000));
  if (minutes === 0) return '不足 1 分钟';
  if (minutes < 60) return minutes + ' 分钟';
  return Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分钟';
}

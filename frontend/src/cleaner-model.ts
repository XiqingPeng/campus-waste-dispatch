import type { Ticket, Snapshot, Bin } from './domain';

export const OVERDUE_MS = 20 * 60_000;
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function dayKey(timestamp: number) {
  return dateFormat.format(timestamp);
}
export function actionable(ticket: Ticket) {
  return ticket.status === 'pending' || ticket.status === 'needs_review';
}
export function overdue(ticket: Ticket, now: number) {
  return actionable(ticket) && now - ticket.opened_at >= OVERDUE_MS;
}
export function oldestFirst(tickets: Ticket[]) {
  return [...tickets].sort((a, b) => a.opened_at - b.opened_at || a.id - b.id);
}
export function closedOn(ticket: Ticket, date: string) {
  return (
    ticket.status === 'closed' &&
    ticket.closed_at != null &&
    dayKey(ticket.closed_at) === date
  );
}
export function eventKey(ticket: Ticket) {
  // IDs can be reused after resetting a demo database.
  return `${ticket.id}:${ticket.opened_at}`;
}

export const DEVICE_TIMEOUT_MS = 120 * 60_000;
export function deviceOnline(bin: Bin, now: number) {
  return (
    !bin.simulated_offline &&
    bin.status !== 'unknown' &&
    bin.received_at != null &&
    now - bin.received_at >= 0 &&
    now - bin.received_at < DEVICE_TIMEOUT_MS
  );
}
export function collectionState(snapshot: Snapshot | null): Snapshot | null {
  if (!snapshot?.collection_points) return null;
  const ids = new Set(snapshot.collection_points.map(point => point.station_id));
  const bins = snapshot.bins.filter(bin => ids.has(bin.station_id));
  const binIds = new Set(bins.map(bin => bin.id));
  const retiredIds = new Set(snapshot.retired_collection_points?.map(point => point.station_id));
  const retiredBins = snapshot.bins.filter(bin => retiredIds.has(bin.station_id));
  const retiredBinIds = new Set(retiredBins.map(bin => bin.id));
  return {
    ...snapshot,
    stations: snapshot.collection_points.map(point => ({
      id: point.station_id, name: point.name, detail: point.zone, zone: point.zone,
      x: point.map_x, y: point.map_y, map_x: point.map_x, map_y: point.map_y,
    })),
    bins,
    tickets: snapshot.tickets.filter(ticket => binIds.has(ticket.bin_id)),
    retired_bins: retiredBins,
    retired_tickets: snapshot.tickets.filter(ticket => retiredBinIds.has(ticket.bin_id)),
    recommendation: null,
  };
}

// One marker summarizes four independent devices; urgent work wins over connectivity.
export function stationStatus(state: Snapshot, stationId: string, now: number) {
  const bins = state.bins.filter(bin => bin.station_id === stationId);
  const ids = new Set(bins.map(bin => bin.id));
  const active = state.tickets.filter(ticket => ids.has(ticket.bin_id) && ticket.status !== 'closed');
  if (active.some(ticket => overdue(ticket, now))) return 'overdue';
  if (active.some(actionable)) return 'full';
  if (active.some(ticket => ticket.status === 'awaiting_verify')) return 'verify';
  if (bins.some(bin => bin.status === 'full')) return 'full';
  if (bins.length !== 4 || bins.some(bin => !deviceOnline(bin, now))) return 'unknown';
  return 'available';
}
export function sortingState(snapshot: Snapshot | null): Snapshot | null {
  if (!snapshot) return null;
  const ids = new Set(snapshot.stations.map((station) => station.id));
  const bins = snapshot.bins.filter((bin) => ids.has(bin.station_id));
  const binIds = new Set(bins.map((bin) => bin.id));
  return {
    ...snapshot,
    bins,
    tickets: snapshot.tickets.filter((ticket) => binIds.has(ticket.bin_id)),
  };
}

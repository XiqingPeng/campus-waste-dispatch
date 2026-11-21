import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/cleaner-model.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { overdue, oldestFirst, closedOn, eventKey } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const ticket = { id: 1, bin_id: 'a-food', opened_at: 1000, status: 'pending' };
test('20-minute boundary excludes already collected tickets awaiting verification', () => {
  assert.equal(overdue(ticket, 1_200_999), false);
  assert.equal(overdue(ticket, 1_201_000), true);
  assert.equal(overdue({ ...ticket, status: 'needs_review' }, 1_201_000), true);
  for (const status of ['awaiting_verify', 'closed']) assert.equal(overdue({ ...ticket, status }, 1_201_000), false);
});
test('queue sorts oldest first without mutating shared API state', () => {
  const input = [{ ...ticket, id: 3, opened_at: 3000 }, { ...ticket, id: 2 }, ticket];
  assert.deepEqual(oldestFirst(input).map(x => x.id), [1, 2, 3]);
  assert.equal(input[0].id, 3);
});
test('daily completion uses Shanghai midnight and verified closure only', () => {
  const closed_at = Date.parse('2026-11-20T16:00:00Z');
  assert.equal(closedOn({ ...ticket, status: 'closed', closed_at }, '2026-11-21'), true);
  assert.equal(closedOn({ ...ticket, status: 'closed', closed_at: closed_at - 1 }, '2026-11-20'), true);
  assert.equal(closedOn({ ...ticket, closed_at }, '2026-11-21'), false);
  assert.equal(closedOn({ ...ticket, status: 'closed', closed_at: null }, '2026-11-21'), false);
});
test('reused demo ticket IDs have distinct notification identities', () => {
  assert.notEqual(eventKey(ticket), eventKey({ ...ticket, opened_at: 2000 }));
});
test('collection map and student sorting receive separate shared-state views', async () => {
  const {collectionState,sortingState}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
  const snapshot={stations:[{id:'a'}],bins:[{id:'a-food',station_id:'a'},{id:'GZ-017',station_id:'GZ-017'}],
    tickets:[ticket,{...ticket,id:2,bin_id:'GZ-017'}],collection_points:[{station_id:'GZ-017',name:'Canteen',zone:'Food',map_x:.4,map_y:.2}]};
  assert.deepEqual(collectionState(snapshot).bins.map(bin=>bin.id),['GZ-017']);
  assert.deepEqual(sortingState(snapshot).tickets.map(t=>t.id),[1]);
  assert.equal(collectionState(snapshot).stations[0].map_x,.4);
});
test('online devices need a recent valid receipt and a known state',async()=>{
  const {deviceOnline,DEVICE_TIMEOUT_MS}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
  const bin={status:'available',received_at:1000};
  assert.equal(deviceOnline(bin,1000),true);
  assert.equal(deviceOnline({...bin,simulated_offline:true},1000),false);
  assert.equal(deviceOnline(bin,1000+DEVICE_TIMEOUT_MS),false);
  assert.equal(deviceOnline({...bin,status:'unknown'},1000),false);
  assert.equal(deviceOnline({...bin,received_at:null},1000),false);
});

test('station marker prioritizes work across four bins and keeps retired records separate', async () => {
  const {stationStatus,collectionState} = await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
  const bins=['recycle','food','residual','hazard'].map(category=>({id:`GZ-001-${category}`,station_id:'GZ-001',category,status:'available',received_at:1_201_000}));
  const base={stations:[],bins,tickets:[]};
  assert.equal(stationStatus(base,'GZ-001',1_201_000),'available');
  assert.equal(stationStatus({...base,bins:bins.slice(0,3)},'GZ-001',1_201_000),'unknown');
  const offline={...base,bins:bins.map((bin,i)=>i?bin:{...bin,simulated_offline:true})};
  assert.equal(stationStatus(offline,'GZ-001',1_201_000),'unknown');
  const verify={...ticket,bin_id:bins[1].id,status:'awaiting_verify'};
  assert.equal(stationStatus({...offline,tickets:[verify]},'GZ-001',1_201_000),'verify');
  const pending={...ticket,id:2,bin_id:bins[2].id,opened_at:1_200_000};
  assert.equal(stationStatus({...offline,tickets:[verify,pending]},'GZ-001',1_201_000),'full');
  const late={...ticket,id:3,bin_id:bins[3].id};
  assert.equal(stationStatus({...offline,tickets:[verify,pending,late]},'GZ-001',1_201_000),'overdue');
  const retired={id:'GZ-002',station_id:'GZ-002'};
  const retiredTicket={...ticket,id:4,bin_id:'GZ-002'};
  const view=collectionState({...base,bins:[...bins,retired],tickets:[pending,retiredTicket],collection_points:[{station_id:'GZ-001'}],retired_collection_points:[{station_id:'GZ-002'}]});
  assert.equal(view.stations.length,1);
  assert.equal(view.bins.length,4);
  assert.deepEqual(view.tickets,[pending]);
  assert.deepEqual(view.retired_tickets,[retiredTicket]);
});

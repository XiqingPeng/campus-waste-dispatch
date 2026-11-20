import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(
  new URL('../src/analysis-contract.ts', import.meta.url),
  'utf8',
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
});
const { normalizeStats, restoreSettings } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);
const range = { start: 1, end: 100, days: 7, source: 'backend' };
const raw = {
  total: 1,
  hourly: [1, ...Array(23).fill(0)],
  zones: [{ name: 'canteen', events: 1, bin_count: 5 }],
};
test('statistics preserve missing values as unknown', () => {
  const result = normalizeStats(raw, range);
  assert.equal(result.resolved, null);
  assert.equal(result.average, null);
  assert.equal(result.zones[0].events, 1);
});
test('invalid statistics fail rather than becoming fabricated zeroes', () => {
  for (const value of [
    { ...raw, total: -1 },
    { ...raw, hourly: [1] },
    { ...raw, total: 2 },
    { ...raw, resolved: 3 },
    { ...raw, zones: [{ name: 'canteen', events: '1' }] },
  ])
    assert.throws(() => normalizeStats(value, range));
});
test('legacy settings discard custom URLs and preserve an existing DeepSeek choice', () => {
  const legacy = {
    statsMode: 'custom',
    statsUrl: 'https://old.example/stats',
    adviceMode: 'deepseek',
    adviceUrl: 'https://old.example/advice',
  };
  assert.deepEqual(restoreSettings(JSON.stringify(legacy)), {
    statsModel: 'none',
    adviceModel: 'deepseek',
  });
  assert.deepEqual(
    restoreSettings(JSON.stringify({ ...legacy, adviceMode: 'custom' })),
    { statsModel: 'none', adviceModel: 'none' },
  );
});
test('model selections restore independently without retaining unrelated fields', () => {
  assert.deepEqual(
    restoreSettings(
      '{"statsModel":"qwen","adviceModel":"openai","statsUrl":"https://old.example"}',
    ),
    { statsModel: 'qwen', adviceModel: 'openai' },
  );
});
test('corrupt or unknown persisted selections safely return to defaults', () => {
  for (const raw of [
    'invalid',
    'null',
    '[]',
    '{"statsModel":"other","adviceModel":"custom"}',
  ])
    assert.deepEqual(restoreSettings(raw), {
      statsModel: 'none',
      adviceModel: 'none',
    });
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../src/analysis-contract.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}});
const {normalizeStats,normalizeAdvice,endpoint,restoreSettings}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
const range={start:1,end:100,days:7,source:'https://example.com'};
const raw={total:1,hourly:[1,...Array(23).fill(0)],zones:[{name:'canteen',events:1,bin_count:5}]};
test('custom statistics preserve absent optional fields as unknown',()=>{
 const result=normalizeStats(raw,range);assert.equal(result.resolved,null);assert.equal(result.average,null);assert.equal(result.zones[0].events,1);
});
test('invalid statistics fail rather than becoming fabricated zeroes',()=>{
 for(const value of [{...raw,total:-1},{...raw,hourly:[1]},{...raw,total:2},{...raw,resolved:3},{...raw,zones:[{name:'canteen',events:'1'}]}])assert.throws(()=>normalizeStats(value,range));
});
test('recommendation API requires evidence and keeps text as data',()=>{
 const stats=normalizeStats(raw,range);
 assert.throws(()=>normalizeAdvice({summary:'ok',suggestions:[{action:'Do work'}]},stats,'api'));
 const data=normalizeAdvice({summary:'<script>text</script>',suggestions:[{action:'Check bins',basis:'1 event'}]},stats,'api');
 assert.equal(data.summary,'<script>text</script>');assert.equal(data.suggestions[0].basis,'1 event');
});
test('endpoint and stored settings validation',()=>{
 assert.throws(()=>endpoint('javascript:alert(1)'));assert.throws(()=>endpoint('https://name:password@example.com'));
 assert.equal(endpoint('http://127.0.0.1:18082/stats').protocol,'http:');
 assert.equal(restoreSettings('invalid').statsMode,'backend');assert.equal(restoreSettings('{"adviceMode":"bogus"}').adviceMode,'rules');
});

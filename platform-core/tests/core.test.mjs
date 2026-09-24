import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../dist/server/index.js';
const get=path=>worker.fetch(new Request('https://example.test'+path));
test('catalog and summary contain only configuration truth',async()=>{
  const response=await get('/api/v1/control-plane/services');
  assert.equal(response.status,200);
  const {services}=await response.json();
  assert.equal(services.length,12);
  assert.ok(services.every(s=>s.connection==='unconfigured'&&s.health==='unknown'&&s.lastObservedAt===null));
  const summary=await (await get('/api/v1/control-plane/summary')).json();
  assert.equal(summary.connectedServices,0);
  assert.equal(summary.unknownHealth,services.length);
});
test('unknown and write routes fail closed',async()=>{
  assert.equal((await get('/api/v1/control-plane/missing')).status,404);
  const response=await worker.fetch(new Request('https://example.test/api/v1/control-plane/services',{method:'POST'}));
  assert.equal(response.status,405);
});
test('frontend and health endpoints respond',async()=>{
  const page=await get('/');
  assert.equal(page.status,200);
  assert.match(await page.text(),/BlueJet/i);
  assert.equal((await (await get('/api/v1/control-plane/health')).json()).status,'ok');
});

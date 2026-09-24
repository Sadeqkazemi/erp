import test from 'node:test';
import assert from 'node:assert/strict';
import {PostgresPanelStore} from '../src/store.mjs';
const input={tenantId:'airline-a',actor:'operator-1',panel:{key:'site-admin',nameFa:'مدیر سایت',nameEn:'Site Admin',group:'employees',ownerService:'site-content',requiredScopes:['content-read']},requestId:'e8bac0e0-0c3d-40f4-8000-000000000001',idempotencyKey:'abcdefghijklmnop'};
function database({replay=false,hashMismatch=false,failAudit=false}={}){
 const log=[];
 const client={async query(sql,args){log.push(sql);if(sql.startsWith('INSERT INTO panel_command_receipts'))return {rowCount:replay?0:1,rows:replay?[]:[{panel_key:'site-admin'}]};if(sql.startsWith('SELECT request_hash'))return {rows:[{request_hash:hashMismatch?'mismatch':(await import('node:crypto')).createHash('sha256').update(JSON.stringify(input.panel)).digest('hex'),panel_key:'site-admin'}]};if(sql.startsWith('SELECT panel_key'))return {rows:[input.panel]};if(sql.startsWith('INSERT INTO panel_registry'))return {rows:[input.panel]};if(sql.startsWith('INSERT INTO panel_audit')&&failAudit)throw Error('audit unavailable');return {rows:[]}},release(){log.push('RELEASE')}};
 return {log,store:new PostgresPanelStore({connect:async()=>client,query:async(sql,args)=>{log.push(sql);assert.equal(args[0],'airline-a');return {rows:[]}}})};
}
test('registration commits receipt, panel and audit atomically',async()=>{const {store,log}=database();assert.equal((await store.register(input)).replayed,false);assert.ok(log.some(s=>s.startsWith('INSERT INTO panel_audit')));assert.ok(log.includes('COMMIT'));assert.ok(log.indexOf('COMMIT')<log.indexOf('RELEASE'))});
test('exact replay does not write panel or audit again',async()=>{const {store,log}=database({replay:true});assert.equal((await store.register(input)).replayed,true);assert.equal(log.some(s=>s.startsWith('INSERT INTO panel_audit')),false)});
test('changed replay conflicts and rolls back',async()=>{const {store,log}=database({replay:true,hashMismatch:true});await assert.rejects(store.register(input),{code:'IDEMPOTENCY_CONFLICT'});assert.ok(log.includes('ROLLBACK'))});
test('audit failure rolls back registration',async()=>{const {store,log}=database({failAudit:true});await assert.rejects(store.register(input));assert.ok(log.includes('ROLLBACK'));assert.equal(log.includes('COMMIT'),false)});

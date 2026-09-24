import {randomUUID} from 'node:crypto';
import {DomainError,listPanels,registerPanel} from './domain.mjs';
const json=(status,body,requestId)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':requestId}});
export function createHandler({store,authenticate}){return async function handle(request){
  const requestId=randomUUID(),path=new URL(request.url).pathname;
  if(path==='/health/live'&&request.method==='GET')return json(200,{status:'ok',time:new Date().toISOString()},requestId);
  if(path!=='/v1/platform/panels')return json(404,{error:{code:'NOT_FOUND'},requestId},requestId);
  if(!['GET','POST'].includes(request.method))return json(405,{error:{code:'METHOD_NOT_ALLOWED'},requestId},requestId);
  const principal=await authenticate(request.headers.get('authorization'));
  if(!principal)return json(401,{error:{code:'UNAUTHORIZED'},requestId},requestId);
  try{
    if(request.method==='GET')return json(200,{items:await listPanels(store,principal),requestId},requestId);
    if(Number(request.headers.get('content-length')||0)>16384)return json(413,{error:{code:'PAYLOAD_TOO_LARGE'},requestId},requestId);
    const body=await request.text();if(body.length>16384)return json(413,{error:{code:'PAYLOAD_TOO_LARGE'},requestId},requestId);
    const result=await registerPanel(store,principal,JSON.parse(body),requestId,request.headers.get('idempotency-key'));
    return json(result.replayed?200:201,{panel:result.panel,requestId},requestId);
  }catch(error){
    if(error instanceof SyntaxError)return json(400,{error:{code:'INVALID_JSON'},requestId},requestId);
    if(error instanceof DomainError)return json(error.status,{error:{code:error.code},requestId},requestId);
    if(error.code==='23505')return json(409,{error:{code:'PANEL_EXISTS'},requestId},requestId);
    console.error(JSON.stringify({event:'platform.request.failed',requestId}));
    return json(503,{error:{code:'SERVICE_UNAVAILABLE'},requestId},requestId);
  }
}}

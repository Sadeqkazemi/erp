import {catalog} from './catalog.js';
import {page} from './page.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
export default {
  async fetch(request){
    const url=new URL(request.url);
    if(request.method!=='GET'&&request.method!=='HEAD')return json({error:{code:'METHOD_NOT_ALLOWED',message:'Read-only endpoint'}},405);
    let response;
    switch(url.pathname){
      case '/': case '/index.html': response=new Response(page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});break;
      case '/api/v1/control-plane/health': response=json({status:'ok',component:'control-plane-api',time:new Date().toISOString()});break;
      case '/api/v1/control-plane/services': response=json({schemaVersion:1,source:'platform-catalog',asOf:new Date().toISOString(),services:catalog});break;
      case '/api/v1/control-plane/summary': response=json({schemaVersion:1,source:'platform-catalog',asOf:new Date().toISOString(),targetServices:catalog.length,connectedServices:0,unknownHealth:catalog.length,liveBusinessData:false});break;
      default: response=json({error:{code:'NOT_FOUND',message:'Endpoint not found'}},404);
    }
    return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
  }
};

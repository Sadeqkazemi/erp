import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import pg from 'pg';
import {createVerifier} from './auth.mjs';
import {createHandler} from './http.mjs';
import {PostgresPanelStore} from './store.mjs';
const required=['DATABASE_URL','OIDC_ISSUER','OIDC_AUDIENCE','OIDC_JWKS_URL'];
for(const name of required)if(!process.env[name])throw new Error(name+'_REQUIRED');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:10,connectionTimeoutMillis:3000,statement_timeout:5000});
const handler=createHandler({store:new PostgresPanelStore(pool),authenticate:createVerifier({issuer:process.env.OIDC_ISSUER,audience:process.env.OIDC_AUDIENCE,jwksUrl:process.env.OIDC_JWKS_URL})});
const port=Number(process.env.PORT||8080);
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const abort=new AbortController();req.on('aborted',()=>abort.abort());
  try{
    const request=new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req),duplex:'half',signal:abort.signal});
    const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE'}}))}
});
server.listen(port,()=>console.log(JSON.stringify({event:'platform.registry.started',port})));
process.on('SIGTERM',()=>server.close(()=>pool.end()));

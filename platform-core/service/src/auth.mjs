import {createPublicKey,verify} from 'node:crypto';
const decode=s=>JSON.parse(Buffer.from(s,'base64url').toString('utf8'));
export function createVerifier({issuer,audience,jwksUrl,fetcher=fetch,now=()=>Date.now()}){
  if(!issuer||!audience||!jwksUrl||!jwksUrl.startsWith('https://'))throw new Error('OIDC_CONFIG_REQUIRED');
  let cache=null,expires=0;
  return async function authenticate(header){
    if(!header?.startsWith('Bearer '))return null;
    try{
      const token=header.slice(7),parts=token.split('.');if(parts.length!==3)return null;
      const head=decode(parts[0]),claims=decode(parts[1]);
      if(head.alg!=='RS256'||!head.kid||claims.iss!==issuer||!(claims.aud===audience||Array.isArray(claims.aud)&&claims.aud.includes(audience))||!claims.sub||!Number.isFinite(claims.exp)||claims.exp<=Math.floor(now()/1000)||claims.nbf&&claims.nbf>Math.floor(now()/1000)||!claims.tenant_id)return null;
      if(!cache||now()>=expires||!cache.keys.some(k=>k.kid===head.kid)){
        const response=await fetcher(jwksUrl,{signal:AbortSignal.timeout(3000)});if(!response.ok)return null;
        cache=await response.json();if(!Array.isArray(cache.keys))return null;expires=now()+300000;
      }
      const jwk=cache.keys.find(k=>k.kid===head.kid&&k.kty==='RSA'&&k.use==='sig');if(!jwk)return null;
      const key=createPublicKey({key:jwk,format:'jwk'});
      if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))return null;
      return {subject:claims.sub,tenantId:claims.tenant_id,roles:Array.isArray(claims.roles)?claims.roles:[],scopes:typeof claims.scope==='string'?claims.scope.split(' '):[]};
    }catch{return null}
  }
}

const slug=/^[a-z][a-z0-9-]{2,62}$/;
const permittedGroups=new Set(['management','operations','employees']);
export function validatePanel(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DomainError('INVALID_PANEL',400);
  const {key,nameFa,nameEn,group,ownerService,requiredScopes}=input;
  if(typeof key!=='string'||!slug.test(key)||typeof nameFa!=='string'||!nameFa.trim()||nameFa.length>120||typeof nameEn!=='string'||!nameEn.trim()||nameEn.length>120||!permittedGroups.has(group)||typeof ownerService!=='string'||!slug.test(ownerService)||!Array.isArray(requiredScopes)||requiredScopes.length>30||requiredScopes.some(s=>typeof s!=='string'||!slug.test(s)))throw new DomainError('INVALID_PANEL',400);
  if(key==='site-admin'&&group!=='employees')throw new DomainError('SITE_ADMIN_GROUP',422);
  return {key,nameFa:nameFa.trim(),nameEn:nameEn.trim(),group,ownerService,requiredScopes:[...new Set(requiredScopes)]};
}
export class DomainError extends Error{constructor(code,status){super(code);this.code=code;this.status=status}}
export async function listPanels(store,principal){
  if(!principal?.scopes?.includes('panel.read'))throw new DomainError('FORBIDDEN',403);
  return store.list(principal.tenantId);
}
export async function registerPanel(store,principal,input,requestId,idempotencyKey){
  if(!principal?.scopes?.includes('panel.write')||!principal.roles?.includes('platform-admin'))throw new DomainError('FORBIDDEN',403);
  if(!principal.tenantId||!principal.subject)throw new DomainError('UNAUTHORIZED',401);
  if(typeof idempotencyKey!=='string'||!/^[-\w]{16,128}$/.test(idempotencyKey))throw new DomainError('IDEMPOTENCY_KEY_REQUIRED',400);
  const panel=validatePanel(input);
  return store.register({tenantId:principal.tenantId,actor:principal.subject,panel,requestId,idempotencyKey});
}

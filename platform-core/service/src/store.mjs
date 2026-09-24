import {createHash,randomUUID} from 'node:crypto';
import {DomainError} from './domain.mjs';
export class PostgresPanelStore{
  constructor(pool){this.pool=pool}
  async list(tenantId){const {rows}=await this.pool.query('SELECT panel_key AS key,name_fa AS "nameFa",name_en AS "nameEn",panel_group AS "group",owner_service AS "ownerService",required_scopes AS "requiredScopes",version,created_at AS "createdAt" FROM panel_registry WHERE tenant_id=$1 ORDER BY panel_key',[tenantId]);return rows}
  async register({tenantId,actor,panel,requestId,idempotencyKey}){
    const hash=createHash('sha256').update(JSON.stringify(panel)).digest('hex');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const receipt=await client.query('INSERT INTO panel_command_receipts(tenant_id,idempotency_key,request_hash,panel_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING panel_key',[tenantId,idempotencyKey,hash,panel.key]);
      if(!receipt.rowCount){
        const old=await client.query('SELECT request_hash,panel_key FROM panel_command_receipts WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',[tenantId,idempotencyKey]);
        if(old.rows[0]?.request_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT',409);
        const found=await client.query('SELECT panel_key AS key,name_fa AS "nameFa",name_en AS "nameEn",panel_group AS "group",owner_service AS "ownerService",required_scopes AS "requiredScopes",version FROM panel_registry WHERE tenant_id=$1 AND panel_key=$2',[tenantId,old.rows[0].panel_key]);
        if(!found.rows[0])throw new Error('MISSING_PANEL_FOR_RECEIPT');
        await client.query('COMMIT');return {panel:found.rows[0],replayed:true};
      }
      const inserted=await client.query('INSERT INTO panel_registry(tenant_id,panel_key,name_fa,name_en,panel_group,owner_service,required_scopes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING panel_key AS key,name_fa AS "nameFa",name_en AS "nameEn",panel_group AS "group",owner_service AS "ownerService",required_scopes AS "requiredScopes",version',[tenantId,panel.key,panel.nameFa,panel.nameEn,panel.group,panel.ownerService,panel.requiredScopes,actor]);
      await client.query('INSERT INTO panel_audit(event_id,tenant_id,panel_key,actor_subject,action,request_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),tenantId,panel.key,actor,'panel.registered',requestId]);
      await client.query('COMMIT');return {panel:inserted.rows[0],replayed:false};
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
}

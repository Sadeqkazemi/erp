import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CoreEnv } from '../src/config/env';
import { createDataSource } from '../src/database/data-source';
import { OutboxEventEntity, PrincipalEntity } from '../src/database/entities';
import { AuthenticatedPrincipal, PlatformCoreService } from '../src/modules/platform-core.service';

const databaseUrl = process.env.PLATFORM_CORE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('outbox failure and operator recovery', () => {
  let db: DataSource;
  let core: PlatformCoreService;
  let actor: AuthenticatedPrincipal;

  beforeAll(async () => {
    db = createDataSource(databaseUrl);
    await db.initialize();
    const id = randomUUID();
    await db.getRepository(PrincipalEntity).save({
      id, realm: 'STAFF', username: `operator-${id}`, tenantId: null, passwordHash: randomUUID(),
      role: 'PLATFORM_ADMIN', status: 'ACTIVE', mfaSecretCiphertext: null, lastTotpStep: null,
    });
    actor = { id, realm: 'STAFF', username: `operator-${id}`, role: 'PLATFORM_ADMIN', tenantId: null, sessionId: randomUUID(), csrfToken: '' };
    core = new PlatformCoreService(db, {
      nodeEnv: 'development', outboxPublishUrl: 'https://broker.internal/events', outboxPublishToken: null,
    } as CoreEnv);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await db?.destroy(); });

  it('retains a failed event, dead-letters it, and requeues the same event ID after review', async () => {
    const event = await db.getRepository(OutboxEventEntity).save({
      id: randomUUID(), eventId: randomUUID(), eventName: 'core.test.recovery.v1',
      aggregateId: randomUUID(), payload: {}, attempts: 7, publishedAt: null,
      deadLetterAt: null, nextAttemptAt: null, lastError: null,
    });
    const send = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    await core.dispatchOutbox();
    const stopped = await db.getRepository(OutboxEventEntity).findOneByOrFail({ id: event.id });
    expect(stopped.publishedAt).toBeNull();
    expect(stopped.deadLetterAt).toBeInstanceOf(Date);
    expect(stopped.attempts).toBe(8);
    expect(await core.listDeadLetters(actor)).toEqual(expect.arrayContaining([expect.objectContaining({ id: event.id, eventId: event.eventId })]));

    await core.requeueDeadLetter(actor, event.id, randomUUID());
    send.mockResolvedValue(new Response(null, { status: 202 }));
    await core.dispatchOutbox();
    const delivered = await db.getRepository(OutboxEventEntity).findOneByOrFail({ id: event.id });
    expect(delivered.publishedAt).toBeInstanceOf(Date);
    expect(delivered.eventId).toBe(event.eventId);
    expect(delivered.deadLetterAt).toBeNull();
  });
});

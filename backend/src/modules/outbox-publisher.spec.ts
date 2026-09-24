import { DataSource } from 'typeorm';
import { CoreEnv } from '../config/env';
import { PlatformCoreService, PublishedEvent } from './platform-core.service';

const event: PublishedEvent = {
  eventId: 'event-123', eventName: 'core.panel.registered.v1', aggregateId: 'panel-123', payload: {},
};

function publisher(env: Partial<CoreEnv>) {
  const service = new PlatformCoreService({} as DataSource, {
    nodeEnv: 'production', outboxPublishUrl: 'https://broker.internal/events', outboxPublishToken: 'fixture',
    ...env,
  } as CoreEnv);
  return service as unknown as { publish(value: PublishedEvent): Promise<void>; publishedEvents(): PublishedEvent[] };
}

describe('durable outbox ingress', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fails closed without a configured ingress outside test mode', async () => {
    await expect(publisher({ outboxPublishUrl: null }).publish(event)).rejects.toThrow('not configured');
  });

  it('keeps a failed HTTP publish unacknowledged', async () => {
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const core = publisher({});
    await expect(core.publish(event)).rejects.toThrow('HTTP 503');
    expect(core.publishedEvents()).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the event ID as an idempotency key and accepts a durable acknowledgment', async () => {
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const core = publisher({});
    await core.publish(event);
    expect(core.publishedEvents()).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('https://broker.internal/events', expect.objectContaining({
      headers: expect.objectContaining({ 'idempotency-key': event.eventId }),
    }));
  });
});

import { Controller, Get, Headers, Inject, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../common/errors';
import { CORE_ENV, CoreEnv } from '../config/env';

@ApiTags('telemetry')
@Controller('metrics')
@SkipThrottle()
export class MetricsController {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(CORE_ENV) private readonly env: CoreEnv,
  ) {}

  @Get()
  @ApiExcludeEndpoint()
  async metrics(@Headers('authorization') authorization: string | undefined, @Res() response: Response): Promise<void> {
    const expected = this.env.metricsBearerToken;
    if (!expected) {
      throw new ServiceUnavailableException({
        code: ErrorCode.IDENTITY_UNAVAILABLE, message: 'خروجی تله‌متری پیکربندی نشده است.',
      });
    }
    const received = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const expectedBytes = Buffer.from(expected);
    const receivedBytes = Buffer.from(received);
    if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHENTICATED, message: 'مجوز تله‌متری معتبر نیست.' });
    }
    const [outbox, workflows, sessions] = await Promise.all([
      this.dataSource.query(`SELECT
        count(*) FILTER (WHERE "publishedAt" IS NULL AND "deadLetterAt" IS NULL)::int AS pending,
        count(*) FILTER (WHERE "publishedAt" IS NULL AND "deadLetterAt" IS NOT NULL)::int AS dead_letters,
        count(*) FILTER (WHERE "publishedAt" IS NULL AND attempts > 0)::int AS retried,
        coalesce(extract(epoch FROM (now() - min("createdAt") FILTER
          (WHERE "publishedAt" IS NULL AND "deadLetterAt" IS NULL))), 0)::bigint AS oldest_pending_seconds
        FROM outbox_events`),
      this.dataSource.query('SELECT status, count(*)::int AS count FROM workflow_runs GROUP BY status ORDER BY status'),
      this.dataSource.query(`SELECT count(*)::int AS active FROM sessions
        WHERE "revokedAt" IS NULL AND "expiresAt" > now()`),
    ]) as [Array<Record<string, string | number>>, Array<{ status: string; count: number }>, Array<{ active: number }>];
    const outboxRow = outbox[0] ?? {};
    const lines = [
      '# HELP bluejet_core_up Platform core telemetry query succeeded.',
      '# TYPE bluejet_core_up gauge',
      'bluejet_core_up 1',
      '# HELP bluejet_core_outbox_events Durable unpublished outbox events by state.',
      '# TYPE bluejet_core_outbox_events gauge',
      `bluejet_core_outbox_events{state="pending"} ${Number(outboxRow.pending ?? 0)}`,
      `bluejet_core_outbox_events{state="dead_letter"} ${Number(outboxRow.dead_letters ?? 0)}`,
      `bluejet_core_outbox_events{state="retried"} ${Number(outboxRow.retried ?? 0)}`,
      '# HELP bluejet_core_outbox_oldest_pending_seconds Age of the oldest publishable event.',
      '# TYPE bluejet_core_outbox_oldest_pending_seconds gauge',
      `bluejet_core_outbox_oldest_pending_seconds ${Number(outboxRow.oldest_pending_seconds ?? 0)}`,
      '# HELP bluejet_core_workflow_runs Durable workflow runs by orchestration status.',
      '# TYPE bluejet_core_workflow_runs gauge',
      ...workflows.map((row) => `bluejet_core_workflow_runs{status="${row.status}"} ${Number(row.count)}`),
      '# HELP bluejet_core_sessions_active Unexpired and unrevoked sessions.',
      '# TYPE bluejet_core_sessions_active gauge',
      `bluejet_core_sessions_active ${Number(sessions[0]?.active ?? 0)}`,
      '# HELP bluejet_core_telemetry_snapshot_timestamp_seconds UTC snapshot time.',
      '# TYPE bluejet_core_telemetry_snapshot_timestamp_seconds gauge',
      `bluejet_core_telemetry_snapshot_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
      '',
    ];
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    response.send(lines.join('\n'));
  }
}

import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { NextFunction, Request, Response } from 'express';
import { IncomingMessage } from 'http';
import { DataSource } from 'typeorm';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { resolveRequestId } from './common/request-id';
import { CORE_ENV, CoreEnv } from './config/env';
import { HealthController } from './modules/health.controller';
import { PlatformCoreController } from './modules/platform-core.controller';
import { PlatformCoreService } from './modules/platform-core.service';

@Module({})
export class AppModule implements NestModule {
  static register(env: CoreEnv, dataSource: DataSource, options?: { logging?: boolean; rateLimit?: boolean }): DynamicModule {
    const logging = options?.logging !== false;
    const rateLimit = options?.rateLimit !== false;
    return {
      module: AppModule,
      imports: [
        ...(logging
          ? [
              LoggerModule.forRoot({
                pinoHttp: {
                  redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token', 'res.headers.set-cookie'],
                  genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id']),
                },
              }),
            ]
          : []),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
      ],
      controllers: [HealthController, PlatformCoreController],
      providers: [
        { provide: CORE_ENV, useValue: env },
        { provide: DataSource, useValue: dataSource },
        PlatformCoreService,
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        ...(rateLimit ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: Request & { id?: string }, res: Response, next: NextFunction) => {
        const requestId = resolveRequestId(req.headers['x-request-id']);
        req.id = requestId;
        res.setHeader('X-Request-Id', requestId);
        next();
      })
      .forRoutes('{*splat}');
  }
}

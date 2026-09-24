import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { IncomingMessage } from 'http';
import { DataSource } from 'typeorm';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CORE_ENV, CoreEnv } from './config/env';
import { HealthController } from './modules/health.controller';
import { PlatformCoreController } from './modules/platform-core.controller';
import { PlatformCoreService } from './modules/platform-core.service';

@Module({})
export class AppModule implements NestModule {
  static register(env: CoreEnv, dataSource: DataSource, options?: { logging?: boolean }): DynamicModule {
    const logging = options?.logging !== false;
    return {
      module: AppModule,
      imports: [
        ...(logging
          ? [
              LoggerModule.forRoot({
                pinoHttp: {
                  redact: ['req.headers.cookie', 'req.headers.authorization'],
                  genReqId: (req: IncomingMessage) => {
                    const header = req.headers['x-request-id'];
                    return (Array.isArray(header) ? header[0] : header) ?? randomUUID();
                  },
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
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: Request & { id?: string }, res: Response, next: NextFunction) => {
        const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        req.id = requestId;
        res.setHeader('X-Request-Id', requestId);
        next();
      })
      .forRoutes('*');
  }
}

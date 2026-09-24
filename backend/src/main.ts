import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { assertProductionSafe, loadEnv } from './config/env';
import { createDataSource } from './database/data-source';
import { PlatformCoreService } from './modules/platform-core.service';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  assertProductionSafe(env);
  const dataSource = createDataSource(env.databaseUrl);
  await dataSource.initialize();
  // Schema changes run separately with the migration role (npm run migration:run).
  if (await dataSource.showMigrations()) {
    throw new Error('Pending migrations: run npm run migration:run with DATABASE_MIGRATION_URL before starting');
  }
  const app = await NestFactory.create(AppModule.register(env, dataSource), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(cookieParser());
  const server = app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void };
  server.set('allowedOrigins', env.allowedOrigins);
  app.enableCors({ origin: env.allowedOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  if (env.exposeApiDocs) {
    const swagger = new DocumentBuilder().setTitle('BlueJet Platform Core').setVersion('v1').build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
  }
  app.enableShutdownHooks();
  await app.listen(env.port);
  // Database row locks coordinate dispatcher replicas; failed deliveries remain pending.
  const core = app.get(PlatformCoreService);
  const dispatchTimer = setInterval(() => {
    void core.dispatchOutbox().catch((error: unknown) => {
      process.stderr.write(`Outbox dispatch failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, 5000);
  const workflowTimer = setInterval(() => {
    void core.expireWorkflowSteps().catch((error: unknown) => {
      process.stderr.write(`Workflow timer failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, 5000);
  app.getHttpServer().on('close', () => clearInterval(dispatchTimer));
  app.getHttpServer().on('close', () => clearInterval(workflowTimer));
}

void bootstrap();

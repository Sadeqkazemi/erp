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

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  assertProductionSafe(env);
  const dataSource = createDataSource(env.databaseUrl);
  await dataSource.initialize();
  await dataSource.runMigrations();
  const app = await NestFactory.create(AppModule.register(env, dataSource), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(cookieParser());
  const server = app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void };
  server.set('allowedOrigins', env.allowedOrigins);
  app.enableCors({ origin: env.allowedOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const swagger = new DocumentBuilder().setTitle('BlueJet Platform Core').setVersion('v1').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
  await app.listen(env.port);
}

void bootstrap();

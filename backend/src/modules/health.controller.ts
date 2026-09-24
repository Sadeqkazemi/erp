import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  @ApiOperation({ summary: 'آمادگی هسته سکو؛ سازگار با مسیر قدیمی health' })
  async check() {
    return this.ready();
  }

  @Get('live')
  @ApiOperation({ summary: 'زنده بودن فرایند بدون وابستگی به سرویس بیرونی' })
  live() {
    return { success: true, data: { status: 'live', service: 'platform-core' } };
  }

  @Get('ready')
  @ApiOperation({ summary: 'آمادگی پایگاه داده و نبود مهاجرت اجرا نشده' })
  async ready() {
    try {
      await this.dataSource.query('SELECT 1');
      if (await this.dataSource.showMigrations()) {
        throw new Error('pending migrations');
      }
    } catch {
      throw new ServiceUnavailableException({
        code: 'INTERNAL',
        message: 'هسته برای دریافت ترافیک آماده نیست.',
      });
    }
    return { success: true, data: { status: 'ready', service: 'platform-core' } };
  }
}

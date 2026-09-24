import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { ErrorCode } from '../errors';

const UNIQUE_VIOLATION = '23505';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body && 'message' in body) {
        const record = body as { code: string; message: string };
        response.status(exception.getStatus()).json({
          success: false,
          error: { code: record.code, message: record.message },
        });
        return;
      }
      response.status(exception.getStatus()).json({
        success: false,
        error: { code: ErrorCode.VALIDATION, message: 'ورودی نامعتبر است.' },
      });
      return;
    }
    if (exception instanceof QueryFailedError && (exception.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION) {
      response.status(HttpStatus.CONFLICT).json({
        success: false,
        error: { code: ErrorCode.CONFLICT, message: 'این رکورد از قبل وجود دارد.' },
      });
      return;
    }
    this.logger.error(exception instanceof Error ? exception.message : 'unknown error');
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ErrorCode.INTERNAL, message: 'خطای داخلی رخ داد.' },
    });
  }
}

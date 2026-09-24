import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode } from '../errors';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
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
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ErrorCode.INTERNAL, message: 'خطای داخلی رخ داد.' },
    });
  }
}

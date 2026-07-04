import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let messages: string | string[];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        messages = res;
      } else {
        messages = (res as unknown as { message: string }).message ?? res;
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      messages = 'Internal server error';
      this.logger.error(exception);
    }
    const errorName =
      status >= 500 ? 'Internal Server Error' : (HttpStatus[status] ?? 'Error');

    response.status(status).json({
      success: false,
      statusCode: status,
      error: errorName,
      message: messages,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}

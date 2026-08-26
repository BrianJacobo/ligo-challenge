import { randomUUID } from 'crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request, Response } from 'express';
import { RequestContextStore } from '../logger/request-context';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const RESPONSE_HEADER = 'X-Correlation-Id';

/**
 * Resolves one correlationId per request — preferring an existing
 * X-Correlation-Id, falling back to Idempotency-Key (so a client's retries and
 * the original request share one id), falling back to a fresh UUID — and makes
 * it available to every log statement in this request via AsyncLocalStorage,
 * without threading it through every method signature.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const correlationId =
      (request.headers[CORRELATION_ID_HEADER] as string | undefined) ||
      (request.headers[IDEMPOTENCY_KEY_HEADER] as string | undefined) ||
      randomUUID();

    response.setHeader(RESPONSE_HEADER, correlationId);

    return new Observable((subscriber) => {
      RequestContextStore.run({ correlationId }, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}

import { of } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { CorrelationIdInterceptor } from './correlation-id.interceptor';
import { RequestContextStore } from '../logger/request-context';

function mockContext(headers: Record<string, string>): ExecutionContext {
  const response = { setHeader: jest.fn() };
  const request = { headers };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function mockCallHandler(captured: { correlationId?: string }): CallHandler {
  return {
    handle: () =>
      of(
        void (captured.correlationId = RequestContextStore.getCorrelationId()),
      ),
  };
}

describe('CorrelationIdInterceptor', () => {
  const interceptor = new CorrelationIdInterceptor();

  it('uses X-Correlation-Id header when present', (done) => {
    const context = mockContext({ 'x-correlation-id': 'given-id' });
    const captured: { correlationId?: string } = {};

    interceptor.intercept(context, mockCallHandler(captured)).subscribe(() => {
      expect(captured.correlationId).toBe('given-id');
      done();
    });
  });

  it('falls back to Idempotency-Key when no X-Correlation-Id is present', (done) => {
    const context = mockContext({ 'idempotency-key': 'idem-key-123' });
    const captured: { correlationId?: string } = {};

    interceptor.intercept(context, mockCallHandler(captured)).subscribe(() => {
      expect(captured.correlationId).toBe('idem-key-123');
      done();
    });
  });

  it('generates a fresh id when neither header is present', (done) => {
    const context = mockContext({});
    const captured: { correlationId?: string } = {};

    interceptor.intercept(context, mockCallHandler(captured)).subscribe(() => {
      expect(captured.correlationId).toBeDefined();
      expect(captured.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      done();
    });
  });

  it('is not visible outside the request scope (AsyncLocalStorage isolation)', () => {
    expect(RequestContextStore.getCorrelationId()).toBeUndefined();
  });
});

import { ConsoleLogger } from '@nestjs/common';
import { RequestContextStore } from './request-context';

/**
 * Drop-in replacement for `new Logger(name)` that prefixes every log line with
 * the request's correlationId (from AsyncLocalStorage) when one is available,
 * so a single request's logs can be grepped end-to-end across services.
 */
export class ContextualLogger extends ConsoleLogger {
  private prefixed(message: unknown): unknown {
    const correlationId = RequestContextStore.getCorrelationId();
    if (!correlationId || typeof message !== 'string') {
      return message;
    }
    return `[correlationId=${correlationId}] ${message}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: any, ...optionalParams: any[]): void {
    super.log(this.prefixed(message), ...optionalParams);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(message: any, ...optionalParams: any[]): void {
    super.warn(this.prefixed(message), ...optionalParams);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(message: any, ...optionalParams: any[]): void {
    super.error(this.prefixed(message), ...optionalParams);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(message: any, ...optionalParams: any[]): void {
    super.debug(this.prefixed(message), ...optionalParams);
  }
}

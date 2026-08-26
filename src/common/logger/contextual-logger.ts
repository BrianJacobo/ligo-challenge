import { ConsoleLogger } from '@nestjs/common';
import { RequestContextStore } from './request-context';

/**
 * Drop-in replacement for `new Logger(name)` that prefixes every log line with
 * the request's correlationId (from AsyncLocalStorage) when one is available,
 * so a single request's logs can be grepped end-to-end across services.
 *
 * Overrides use `any` to match Nest's own ConsoleLogger method signatures
 * exactly — narrowing them here would break the override contract.
 */
export class ContextualLogger extends ConsoleLogger {
  private prefixed(message: unknown): unknown {
    const correlationId = RequestContextStore.getCorrelationId();
    if (!correlationId || typeof message !== 'string') {
      return message;
    }
    return `[correlationId=${correlationId}] ${message}`;
  }

  log(message: any, ...optionalParams: any[]): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    super.log(this.prefixed(message), ...optionalParams);
  }

  warn(message: any, ...optionalParams: any[]): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    super.warn(this.prefixed(message), ...optionalParams);
  }

  error(message: any, ...optionalParams: any[]): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    super.error(this.prefixed(message), ...optionalParams);
  }

  debug(message: any, ...optionalParams: any[]): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    super.debug(this.prefixed(message), ...optionalParams);
  }
}

import { Module } from '@nestjs/common';
import { IdempotencyLockService } from './idempotency-lock.service';
import { redisClientProvider } from './redis-client.provider';

@Module({
  providers: [redisClientProvider, IdempotencyLockService],
  exports: [IdempotencyLockService],
})
export class IdempotencyModule {}

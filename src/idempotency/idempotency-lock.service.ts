import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis-client.provider';

export interface AcquiredLock {
  key: string;
  token: string;
}

/**
 * Release script: only deletes the key if it still holds the token we set.
 * Prevents releasing a lock that expired and was re-acquired by another pod
 * (check-and-delete must be atomic, not two separate round trips).
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const LOCK_KEY_PREFIX = 'idempotency:';

@Injectable()
export class IdempotencyLockService implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async acquire(
    idempotencyKey: string,
    ttlMs: number,
  ): Promise<AcquiredLock | null> {
    const key = `${LOCK_KEY_PREFIX}${idempotencyKey}`;
    const token = randomUUID();

    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');

    return result === 'OK' ? { key, token } : null;
  }

  async release(lock: AcquiredLock): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}

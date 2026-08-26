import Redis from 'ioredis';
import { IdempotencyLockService } from './idempotency-lock.service';

const REDIS_URL = process.env.REDIS_URL_TEST ?? 'redis://localhost:6379';

describe('IdempotencyLockService', () => {
  let redis: Redis;
  let service: IdempotencyLockService;

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
    service = new IdempotencyLockService(redis);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('acquires a lock for a fresh key', async () => {
    const lock = await service.acquire('key-1', 5000);

    expect(lock).not.toBeNull();
    expect(lock?.key).toBe('idempotency:key-1');
  });

  it('only one of two concurrent acquires on the same key succeeds', async () => {
    const [first, second] = await Promise.all([
      service.acquire('key-concurrent', 5000),
      service.acquire('key-concurrent', 5000),
    ]);

    const successes = [first, second].filter((lock) => lock !== null);
    expect(successes).toHaveLength(1);
  });

  it('allows re-acquiring after release', async () => {
    const lock = await service.acquire('key-2', 5000);
    expect(lock).not.toBeNull();

    await service.release(lock!);

    const reacquired = await service.acquire('key-2', 5000);
    expect(reacquired).not.toBeNull();
  });

  it('does not release a lock held by a different token (expired-then-stolen scenario)', async () => {
    const original = await service.acquire('key-3', 5000);
    expect(original).not.toBeNull();

    // Simulate: original lock expired and another pod re-acquired the same key.
    await redis.del(original!.key);
    const stolenByAnotherPod = await service.acquire('key-3', 5000);
    expect(stolenByAnotherPod).not.toBeNull();

    // The original holder's release must NOT delete the other pod's lock.
    await service.release(original!);

    const stillHeld = await redis.get('idempotency:key-3');
    expect(stillHeld).toBe(stolenByAnotherPod!.token);
  });

  it('expires automatically after the TTL', async () => {
    await service.acquire('key-ttl', 100);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const reacquired = await service.acquire('key-ttl', 5000);
    expect(reacquired).not.toBeNull();
  });
});

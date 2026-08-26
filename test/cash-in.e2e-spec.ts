import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import request from 'supertest';
import { createTestApp } from './helpers/create-test-app';

describe('POST /cash-in (e2e)', () => {
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    app = await createTestApp();
    connection = app.get(getConnectionToken());
  });

  afterEach(async () => {
    await connection.collection('cash_in_operations').deleteMany({});
    await connection.collection('wallets').deleteMany({});
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await app.close();
  });

  const validPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
    user_id: 'usr_abc123',
    amount: 100,
    currency: 'PEN',
    payment_method: 'card_xyz',
    ...overrides,
  });

  it('processes a successful cash-in and credits the wallet', async () => {
    const idempotencyKey = randomUUID();

    const response = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(validPayload())
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'completed',
      amount: 100,
      new_balance: 100,
    });
    expect(response.body.operation_id).toMatch(/^op_/);
  });

  it('rejects requests without an Idempotency-Key header', async () => {
    await request(app.getHttpServer())
      .post('/cash-in')
      .send(validPayload())
      .expect(400);
  });

  it('rejects requests with a malformed Idempotency-Key', async () => {
    await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', 'not-a-uuid')
      .send(validPayload())
      .expect(400);
  });

  it('rejects payloads with unknown extra fields (whitelist + forbidNonWhitelisted)', async () => {
    await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', randomUUID())
      .send(validPayload({ extra_field: 'should not be allowed' }))
      .expect(400);
  });

  it('returns the same response when retried with the same Idempotency-Key and payload', async () => {
    const idempotencyKey = randomUUID();
    const payload = validPayload({ user_id: 'usr_retry' });

    const first = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);

    const second = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);

    expect(second.body).toEqual(first.body);

    // Balance must reflect a single credit, not two.
    const third = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);
    expect(third.body.new_balance).toBe(first.body.new_balance);
  });

  it('rejects reusing the same Idempotency-Key with a different payload', async () => {
    const idempotencyKey = randomUUID();
    const userId = 'usr_conflict';

    await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(validPayload({ user_id: userId, amount: 100 }))
      .expect(200);

    await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(validPayload({ user_id: userId, amount: 200 }))
      .expect(409);
  });

  it('does not double-charge under N concurrent requests with the same Idempotency-Key', async () => {
    const idempotencyKey = randomUUID();
    const payload = validPayload({ user_id: 'usr_concurrent' });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer())
          .post('/cash-in')
          .set('Idempotency-Key', idempotencyKey)
          .send(payload),
      ),
    );

    const operationIds = new Set(
      responses.filter((r) => r.body.operation_id).map((r) => r.body.operation_id),
    );
    expect(operationIds.size).toBe(1);

    const balanceResponses = responses
      .filter((r) => r.body.new_balance !== undefined)
      .map((r) => r.body.new_balance);
    // Every response that reports a balance must report the SAME balance —
    // proof the provider/wallet credit only happened once.
    expect(new Set(balanceResponses).size).toBe(1);
    expect(balanceResponses[0]).toBe(100);
  });

  it('leaves the operation pending and does not credit the wallet on provider timeout', async () => {
    const idempotencyKey = randomUUID();

    const response = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(validPayload({ user_id: 'usr_timeout', payment_method: 'card_force_timeout' }))
      .expect(200);

    expect(response.body.status).toBe('pending');

    const stored = await connection
      .collection('cash_in_operations')
      .findOne({ idempotencyKey });
    expect(stored?.status).toBe('pending');

    const wallet = await connection.collection('wallets').findOne({ userId: 'usr_timeout' });
    expect(wallet).toBeNull();
  });

  it('marks the operation as failed and does not credit the wallet on provider failure', async () => {
    const idempotencyKey = randomUUID();

    const response = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', idempotencyKey)
      .send(validPayload({ user_id: 'usr_failure', payment_method: 'card_force_failure' }))
      .expect(200);

    expect(response.body.status).toBe('failed');

    const wallet = await connection.collection('wallets').findOne({ userId: 'usr_failure' });
    expect(wallet).toBeNull();
  });
});

import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import request from 'supertest';
import { createTestApp } from './helpers/create-test-app';

describe('POST /webhooks/payment (e2e)', () => {
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    app = await createTestApp();
    connection = app.get(getConnectionToken());
  });

  afterEach(async () => {
    await connection.collection('cash_in_operations').deleteMany({});
    await connection.collection('wallets').deleteMany({});
    await connection.collection('pending_webhooks').deleteMany({});
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await app.close();
  });

  const webhookPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
    operation_id: 'op_test',
    provider_reference: 'prov_ref_1',
    status: 'success',
    timestamp: new Date().toISOString(),
    ...overrides,
  });

  it('creates a pending cash-in operation directly in Mongo for test setup', async () => {
    // Helper assertion just to document the fixture shape used below.
    await connection.collection('cash_in_operations').insertOne({
      operationId: 'op_fixture_check',
      idempotencyKey: randomUUID(),
      userId: 'usr_1',
      amount: 50,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      status: 'pending',
      providerReference: null,
      requestHash: 'hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const found = await connection
      .collection('cash_in_operations')
      .findOne({ operationId: 'op_fixture_check' });
    expect(found?.status).toBe('pending');
  });

  it('marks a pending operation as completed and credits the wallet on success', async () => {
    const operationId = 'op_success_1';
    await connection.collection('cash_in_operations').insertOne({
      operationId,
      idempotencyKey: randomUUID(),
      userId: 'usr_webhook_success',
      amount: 75,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      status: 'pending',
      providerReference: null,
      requestHash: 'hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(webhookPayload({ operation_id: operationId, status: 'success' }))
      .expect(200);

    const operation = await connection
      .collection('cash_in_operations')
      .findOne({ operationId });
    expect(operation?.status).toBe('completed');

    const wallet = await connection
      .collection('wallets')
      .findOne({ userId: 'usr_webhook_success' });
    expect(wallet?.balance).toBe(75);
  });

  it('marks a pending operation as failed and does not credit the wallet', async () => {
    const operationId = 'op_failed_1';
    await connection.collection('cash_in_operations').insertOne({
      operationId,
      idempotencyKey: randomUUID(),
      userId: 'usr_webhook_failed',
      amount: 75,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      status: 'pending',
      providerReference: null,
      requestHash: 'hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(webhookPayload({ operation_id: operationId, status: 'failed' }))
      .expect(200);

    const operation = await connection
      .collection('cash_in_operations')
      .findOne({ operationId });
    expect(operation?.status).toBe('failed');

    const wallet = await connection
      .collection('wallets')
      .findOne({ userId: 'usr_webhook_failed' });
    expect(wallet).toBeNull();
  });

  it('ignores a duplicate webhook without crediting the wallet twice', async () => {
    const operationId = 'op_duplicate_1';
    await connection.collection('cash_in_operations').insertOne({
      operationId,
      idempotencyKey: randomUUID(),
      userId: 'usr_webhook_duplicate',
      amount: 40,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      status: 'pending',
      providerReference: null,
      requestHash: 'hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const payload = webhookPayload({ operation_id: operationId, status: 'success' });

    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(payload)
      .expect(200);

    // Same webhook resent (e.g. provider retry policy).
    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(payload)
      .expect(200);

    const wallet = await connection
      .collection('wallets')
      .findOne({ userId: 'usr_webhook_duplicate' });
    expect(wallet?.balance).toBe(40);
  });

  it('does not let an out-of-order "failed" overwrite an already-completed operation', async () => {
    const operationId = 'op_out_of_order_1';
    await connection.collection('cash_in_operations').insertOne({
      operationId,
      idempotencyKey: randomUUID(),
      userId: 'usr_webhook_ooo',
      amount: 60,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      status: 'pending',
      providerReference: null,
      requestHash: 'hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(webhookPayload({ operation_id: operationId, status: 'success' }))
      .expect(200);

    // A stale/out-of-order "failed" event arrives after "success" was already applied.
    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(webhookPayload({ operation_id: operationId, status: 'failed' }))
      .expect(200);

    const operation = await connection
      .collection('cash_in_operations')
      .findOne({ operationId });
    expect(operation?.status).toBe('completed');

    const wallet = await connection
      .collection('wallets')
      .findOne({ userId: 'usr_webhook_ooo' });
    expect(wallet?.balance).toBe(60);
  });

  it('buffers a webhook for an operation that does not exist yet, without throwing', async () => {
    const operationId = 'op_does_not_exist_yet';

    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(webhookPayload({ operation_id: operationId, status: 'success' }))
      .expect(200);

    const buffered = await connection
      .collection('pending_webhooks')
      .findOne({ operationId });
    expect(buffered?.status).toBe('completed');

    // No cash_in_operations document was created just because the webhook arrived.
    const operation = await connection
      .collection('cash_in_operations')
      .findOne({ operationId });
    expect(operation).toBeNull();
  });

  // The "webhook arrives before POST /cash-in inserts the operation, and gets
  // drained once it does" scenario is covered in
  // src/cash-in/cash-in.service.spec.ts, with mocked dependencies — that's the
  // only way to deterministically control the race (the buffered webhook must
  // exist strictly before the insert completes). An e2e test here can't force
  // that ordering without reaching into internals, so it would just re-buffer
  // manually without exercising CashInService's actual drain code path.
});

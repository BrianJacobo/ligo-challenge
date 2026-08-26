import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CashInService } from './cash-in.service';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { OperationTransitionService } from './operation-transition.service';
import { IdempotencyLockService } from '../idempotency/idempotency-lock.service';
import { WalletService } from '../wallet/wallet.service';
import { PendingWebhookRepository } from '../webhooks/pending-webhook.repository';
import { PAYMENT_PROVIDER } from '../payment-provider/payment-provider.interface';

describe('CashInService — resilience to infrastructure failures', () => {
  const dto = {
    user_id: 'usr_1',
    amount: 100,
    currency: 'PEN',
    payment_method: 'card_xyz',
  };

  async function buildService(overrides: {
    repository?: Partial<Record<keyof CashInOperationRepository, jest.Mock>>;
    lockService?: Partial<Record<keyof IdempotencyLockService, jest.Mock>>;
  }) {
    const repository = {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      insertPending: jest.fn(),
      ...overrides.repository,
    };

    const lockService = {
      acquire: jest
        .fn()
        .mockResolvedValue({ key: 'idempotency:key', token: 't' }),
      release: jest.fn().mockResolvedValue(undefined),
      ...overrides.lockService,
    };

    const walletService = {
      creditBalance: jest.fn().mockResolvedValue(100),
      getBalance: jest.fn().mockResolvedValue(0),
    };

    const pendingWebhookRepository = {
      takeByOperationId: jest.fn().mockResolvedValue(null),
      buffer: jest.fn(),
    };

    const transitionService = { resolve: jest.fn() };

    const paymentProvider = {
      charge: jest
        .fn()
        .mockResolvedValue({ outcome: 'success', providerReference: 'prov_1' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CashInService,
        { provide: CashInOperationRepository, useValue: repository },
        { provide: IdempotencyLockService, useValue: lockService },
        { provide: WalletService, useValue: walletService },
        { provide: OperationTransitionService, useValue: transitionService },
        {
          provide: PendingWebhookRepository,
          useValue: pendingWebhookRepository,
        },
        { provide: PAYMENT_PROVIDER, useValue: paymentProvider },
      ],
    }).compile();

    return {
      service: moduleRef.get(CashInService),
      repository,
      lockService,
      paymentProvider,
    };
  }

  it('responds 503 instead of a false success when Mongo fails to persist the operation', async () => {
    const { service, repository } = await buildService({
      repository: {
        insertPending: jest
          .fn()
          .mockRejectedValue(new Error('connection timed out')),
      },
    });

    await expect(service.process(dto, 'key-mongo-down')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(repository.insertPending).toHaveBeenCalledTimes(1);
  });

  it('degrades to Mongo-only idempotency when Redis is unavailable, instead of failing the request', async () => {
    const insertedOperation = {
      operationId: 'op_no_redis',
      idempotencyKey: 'key-redis-down',
      userId: dto.user_id,
      amount: dto.amount,
      currency: dto.currency,
      paymentMethod: dto.payment_method,
      status: 'pending',
      requestHash: 'hash',
    };

    const { service, lockService, paymentProvider } = await buildService({
      lockService: {
        acquire: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      },
      repository: {
        insertPending: jest.fn().mockResolvedValue(insertedOperation),
      },
    });

    const result = await service.process(dto, 'key-redis-down');

    expect(lockService.acquire).toHaveBeenCalledTimes(1);
    // release() must never be called with a lock we never actually acquired.
    expect(lockService.release).not.toHaveBeenCalled();
    // The request still completes successfully — Mongo's unique index is the
    // real guarantee, Redis was only ever an optimization.
    expect(paymentProvider.charge).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ operation_id: 'op_no_redis' });
  });
});

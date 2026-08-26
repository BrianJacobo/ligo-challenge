import { Test } from '@nestjs/testing';
import { CashInService } from './cash-in.service';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { OperationTransitionService } from './operation-transition.service';
import { IdempotencyLockService } from '../idempotency/idempotency-lock.service';
import { WalletService } from '../wallet/wallet.service';
import { PendingWebhookRepository } from '../webhooks/pending-webhook.repository';
import { PAYMENT_PROVIDER } from '../payment-provider/payment-provider.interface';

describe('CashInService — early webhook drain', () => {
  const dto = {
    user_id: 'usr_1',
    amount: 100,
    currency: 'PEN',
    payment_method: 'card_xyz',
  };

  it('applies a webhook that was buffered before the operation existed, and never calls the provider', async () => {
    const insertedOperation = {
      operationId: 'op_generated_1',
      idempotencyKey: 'key-1',
      userId: dto.user_id,
      amount: dto.amount,
      currency: dto.currency,
      paymentMethod: dto.payment_method,
      status: 'pending',
      requestHash: 'hash',
    };

    const repository = {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      insertPending: jest.fn().mockResolvedValue(insertedOperation),
      updateStatusIfPending: jest.fn(),
    };

    const lockService = {
      acquire: jest
        .fn()
        .mockResolvedValue({ key: 'idempotency:key-1', token: 't' }),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const walletService = {
      creditBalance: jest.fn().mockResolvedValue(100),
      getBalance: jest.fn().mockResolvedValue(100),
    };

    // Simulates the webhook having arrived and been buffered BEFORE
    // insertPending() resolves — the exact race described in the challenge
    // ("webhook antes que la respuesta del API").
    const pendingWebhookRepository = {
      takeByOperationId: jest.fn().mockResolvedValue({
        operationId: 'op_generated_1',
        status: 'completed',
        providerReference: 'prov_early',
      }),
      buffer: jest.fn(),
    };

    const transitionService = {
      resolve: jest
        .fn()
        .mockResolvedValue({ ...insertedOperation, status: 'completed' }),
    };

    const paymentProvider = { charge: jest.fn() };

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

    const service = moduleRef.get(CashInService);

    const result = await service.process(dto, 'key-1');

    expect(pendingWebhookRepository.takeByOperationId).toHaveBeenCalledWith(
      'op_generated_1',
    );
    expect(transitionService.resolve).toHaveBeenCalledWith(
      'op_generated_1',
      dto.user_id,
      dto.amount,
      'completed',
      'prov_early',
    );
    // The provider must never be called — the webhook already settled the outcome.
    expect(paymentProvider.charge).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      operation_id: 'op_generated_1',
      status: 'completed',
    });
  });

  it('falls through to charging the provider when no webhook was buffered', async () => {
    const insertedOperation = {
      operationId: 'op_generated_2',
      idempotencyKey: 'key-2',
      userId: dto.user_id,
      amount: dto.amount,
      currency: dto.currency,
      paymentMethod: dto.payment_method,
      status: 'pending',
      requestHash: 'hash',
    };

    const repository = {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      insertPending: jest.fn().mockResolvedValue(insertedOperation),
    };

    const lockService = {
      acquire: jest
        .fn()
        .mockResolvedValue({ key: 'idempotency:key-2', token: 't' }),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const walletService = {
      creditBalance: jest.fn().mockResolvedValue(100),
      getBalance: jest.fn().mockResolvedValue(100),
    };

    const pendingWebhookRepository = {
      takeByOperationId: jest.fn().mockResolvedValue(null),
      buffer: jest.fn(),
    };

    const transitionService = {
      resolve: jest.fn().mockResolvedValue(insertedOperation),
    };

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

    const service = moduleRef.get(CashInService);

    await service.process(dto, 'key-2');

    expect(paymentProvider.charge).toHaveBeenCalledTimes(1);
  });
});

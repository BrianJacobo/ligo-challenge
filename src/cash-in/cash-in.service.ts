import { randomUUID, createHash } from 'crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  PaymentProviderTimeoutError,
} from '../payment-provider/payment-provider.interface';
import type { PaymentProvider } from '../payment-provider/payment-provider.interface';
import { IdempotencyLockService } from '../idempotency/idempotency-lock.service';
import { WalletService } from '../wallet/wallet.service';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { CashInOperationDocument } from './schemas/cash-in-operation.schema';
import { CreateCashInDto } from './dto/create-cash-in.dto';
import { CashInResponseDto } from './dto/cash-in-response.dto';

const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_RETRIES = 3;
const LOCK_WAIT_BACKOFF_MS = 200;

export class OperationInProgressException extends ConflictException {
  constructor() {
    super('Operation is already in progress for this Idempotency-Key, retry shortly');
  }
}

export class IdempotencyKeyConflictException extends ConflictException {
  constructor() {
    super('Idempotency-Key was already used with a different request payload');
  }
}

export interface PendingVerificationResult {
  operation_id: string;
  status: 'pending';
  message: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class CashInService {
  private readonly logger = new Logger(CashInService.name);

  constructor(
    private readonly repository: CashInOperationRepository,
    private readonly lockService: IdempotencyLockService,
    private readonly walletService: WalletService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  async process(
    dto: CreateCashInDto,
    idempotencyKey: string,
  ): Promise<CashInResponseDto | PendingVerificationResult> {
    const requestHash = this.hashRequest(dto);

    const lock = await this.lockService.acquire(idempotencyKey, LOCK_TTL_MS);

    if (!lock) {
      return this.waitForConcurrentResult(idempotencyKey, requestHash);
    }

    try {
      const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return this.resolveExisting(existing, requestHash);
      }

      let operation: CashInOperationDocument;
      try {
        operation = await this.repository.insertPending({
          operationId: `op_${randomUUID()}`,
          idempotencyKey,
          userId: dto.user_id,
          amount: dto.amount,
          currency: dto.currency,
          paymentMethod: dto.payment_method,
          requestHash,
        });
      } catch {
        // Lost a race the lock didn't cover (e.g. another pod inserted between
        // our findByIdempotencyKey and insertPending). The unique index is the
        // final guarantee here.
        const raced = await this.repository.findByIdempotencyKey(idempotencyKey);
        if (!raced) {
          throw new Error(
            `Insert conflicted on idempotencyKey "${idempotencyKey}" but no document was found afterwards`,
          );
        }
        return this.resolveExisting(raced, requestHash);
      }

      return await this.chargeAndResolve(operation, dto);
    } finally {
      await this.lockService.release(lock);
    }
  }

  private async chargeAndResolve(
    operation: CashInOperationDocument,
    dto: CreateCashInDto,
  ): Promise<CashInResponseDto | PendingVerificationResult> {
    try {
      const result = await this.paymentProvider.charge({
        amount: dto.amount,
        currency: dto.currency,
        paymentMethod: dto.payment_method,
      });

      if (result.outcome === 'success') {
        const updated = await this.repository.updateStatusIfPending(
          operation.operationId,
          'completed',
          result.providerReference ?? null,
        );
        const newBalance = await this.walletService.creditBalance(
          dto.user_id,
          dto.amount,
        );
        return this.toResponseDto(updated ?? operation, newBalance);
      }

      // Explicit failure — never touch the balance.
      const updated = await this.repository.updateStatusIfPending(
        operation.operationId,
        'failed',
        null,
      );
      const balance = await this.walletService.getBalance(dto.user_id);
      return this.toResponseDto(updated ?? operation, balance);
    } catch (error) {
      if (error instanceof PaymentProviderTimeoutError) {
        this.logger.warn(
          `Provider timeout for operation ${operation.operationId}; leaving status as pending`,
        );
        return {
          operation_id: operation.operationId,
          status: 'pending',
          message:
            'Payment provider did not respond in time. The charge outcome is unknown; retry with the same Idempotency-Key once confirmed.',
        };
      }
      throw error;
    }
  }

  private async resolveExisting(
    existing: CashInOperationDocument,
    requestHash: string,
  ): Promise<CashInResponseDto | PendingVerificationResult> {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyKeyConflictException();
    }

    if (existing.status === 'pending') {
      return {
        operation_id: existing.operationId,
        status: 'pending',
        message: 'Operation is still being verified with the payment provider.',
      };
    }

    const balance = await this.walletService.getBalance(existing.userId);
    return this.toResponseDto(existing, balance);
  }

  private async waitForConcurrentResult(
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CashInResponseDto | PendingVerificationResult> {
    for (let attempt = 0; attempt < LOCK_WAIT_RETRIES; attempt++) {
      await delay(LOCK_WAIT_BACKOFF_MS);
      const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return this.resolveExisting(existing, requestHash);
      }
    }

    throw new OperationInProgressException();
  }

  private toResponseDto(
    operation: CashInOperationDocument,
    newBalance: number,
  ): CashInResponseDto {
    return {
      operation_id: operation.operationId,
      status: operation.status,
      amount: operation.amount,
      new_balance: newBalance,
    };
  }

  private hashRequest(dto: CreateCashInDto): string {
    return createHash('sha256')
      .update(`${dto.user_id}:${dto.amount}:${dto.currency}:${dto.payment_method}`)
      .digest('hex');
  }
}

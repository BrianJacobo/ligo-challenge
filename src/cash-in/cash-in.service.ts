import { randomUUID, createHash } from 'crypto';
import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  PaymentProviderTimeoutError,
} from '../payment-provider/payment-provider.interface';
import type { PaymentProvider } from '../payment-provider/payment-provider.interface';
import { IdempotencyLockService } from '../idempotency/idempotency-lock.service';
import { WalletService } from '../wallet/wallet.service';
import {
  CashInOperationRepository,
  DuplicateIdempotencyKeyError,
} from './cash-in-operation.repository';
import { OperationTransitionService } from './operation-transition.service';
import { PendingWebhookRepository } from '../webhooks/pending-webhook.repository';
import { CashInOperationDocument } from './schemas/cash-in-operation.schema';
import { CreateCashInDto } from './dto/create-cash-in.dto';
import { CashInResponseDto } from './dto/cash-in-response.dto';
import { ContextualLogger } from '../common/logger/contextual-logger';

const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_RETRIES = 3;
const LOCK_WAIT_BACKOFF_MS = 200;

export class OperationInProgressException extends ConflictException {
  constructor() {
    super(
      'Operation is already in progress for this Idempotency-Key, retry shortly',
    );
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
  private readonly logger = new ContextualLogger(CashInService.name);

  constructor(
    private readonly repository: CashInOperationRepository,
    private readonly lockService: IdempotencyLockService,
    private readonly walletService: WalletService,
    private readonly transitionService: OperationTransitionService,
    private readonly pendingWebhookRepository: PendingWebhookRepository,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  async process(
    dto: CreateCashInDto,
    idempotencyKey: string,
  ): Promise<CashInResponseDto | PendingVerificationResult> {
    this.logger.log(
      `Processing cash-in for user ${dto.user_id}, amount ${dto.amount} ${dto.currency}, idempotencyKey ${idempotencyKey}`,
    );

    const requestHash = this.hashRequest(dto);

    // Redis is a concurrency optimization, not the idempotency guarantee — if
    // it's unreachable, degrade to relying solely on Mongo's unique index
    // instead of failing the whole request. This raises (but doesn't eliminate)
    // the odds of calling the payment provider twice for a race the lock would
    // have prevented; it can NEVER cause double-crediting, since the
    // conditional transition + unique index still apply either way.
    let lock: Awaited<ReturnType<IdempotencyLockService['acquire']>> = null;
    let redisAvailable = true;
    try {
      lock = await this.lockService.acquire(idempotencyKey, LOCK_TTL_MS);
    } catch (error) {
      redisAvailable = false;
      this.logger.warn(
        `Redis lock unavailable, proceeding without it (Mongo's unique index remains the final guarantee): ${String(error)}`,
      );
    }

    if (redisAvailable && !lock) {
      // Redis is up but another request already holds the lock for this key —
      // wait briefly for it to finish rather than racing the insert ourselves.
      return this.waitForConcurrentResult(idempotencyKey, requestHash);
    }

    try {
      const existing =
        await this.repository.findByIdempotencyKey(idempotencyKey);
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
      } catch (error) {
        if (!(error instanceof DuplicateIdempotencyKeyError)) {
          // A real Mongo failure (connection drop, timeout, etc.) — never
          // report success if we can't confirm the write happened. The client
          // must retry; idempotency guarantees that's safe.
          this.logger.error(
            `Failed to persist cash-in operation for idempotencyKey ${idempotencyKey}: ${String(error)}`,
          );
          throw new ServiceUnavailableException(
            'Could not persist the operation, please retry with the same Idempotency-Key',
          );
        }
        // Lost a race the lock didn't cover (e.g. another pod inserted between
        // our findByIdempotencyKey and insertPending). The unique index is the
        // final guarantee here.
        const raced =
          await this.repository.findByIdempotencyKey(idempotencyKey);
        if (!raced) {
          throw new Error(
            `Insert conflicted on idempotencyKey "${idempotencyKey}" but no document was found afterwards`,
          );
        }
        return this.resolveExisting(raced, requestHash);
      }

      // The operation now exists — if a webhook arrived earlier and was buffered
      // (see plan.md "Flujo: POST /webhooks/payment", paso 3), apply it now
      // instead of racing the payment provider call below.
      const bufferedResult = await this.applyBufferedWebhookIfAny(
        operation,
        dto,
      );
      if (bufferedResult) {
        return bufferedResult;
      }

      return await this.chargeAndResolve(operation, dto);
    } finally {
      if (lock) {
        await this.lockService.release(lock);
      }
    }
  }

  private async applyBufferedWebhookIfAny(
    operation: CashInOperationDocument,
    dto: CreateCashInDto,
  ): Promise<CashInResponseDto | null> {
    const buffered = await this.pendingWebhookRepository.takeByOperationId(
      operation.operationId,
    );
    if (!buffered) {
      return null;
    }

    this.logger.log(
      `Applying webhook that arrived before operation ${operation.operationId} existed`,
    );
    const updated = await this.transitionService.resolve(
      operation.operationId,
      dto.user_id,
      dto.amount,
      buffered.status,
      buffered.providerReference,
    );

    const balance = await this.walletService.getBalance(dto.user_id);
    return this.toResponseDto(updated ?? operation, balance);
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

      this.logger.log(
        `Payment provider responded for operation ${operation.operationId}: outcome=${result.outcome}`,
      );

      const newStatus = result.outcome === 'success' ? 'completed' : 'failed';
      const updated = await this.transitionService.resolve(
        operation.operationId,
        dto.user_id,
        dto.amount,
        newStatus,
        result.providerReference ?? null,
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
      const existing =
        await this.repository.findByIdempotencyKey(idempotencyKey);
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
      .update(
        `${dto.user_id}:${dto.amount}:${dto.currency}:${dto.payment_method}`,
      )
      .digest('hex');
  }
}

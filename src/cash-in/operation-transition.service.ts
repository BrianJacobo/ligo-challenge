import { Injectable } from '@nestjs/common';
import { WalletService } from '../wallet/wallet.service';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { CashInOperationDocument } from './schemas/cash-in-operation.schema';
import { ContextualLogger } from '../common/logger/contextual-logger';

/**
 * Applies the conditional "pending -> completed/failed" transition and, only when
 * that transition actually happens (never on a no-op), credits the wallet. Shared
 * by the synchronous POST /cash-in flow and the webhook handler so the "credit
 * exactly once" rule lives in a single place.
 */
@Injectable()
export class OperationTransitionService {
  private readonly logger = new ContextualLogger(
    OperationTransitionService.name,
  );

  constructor(
    private readonly repository: CashInOperationRepository,
    private readonly walletService: WalletService,
  ) {}

  async resolve(
    operationId: string,
    userId: string,
    amount: number,
    newStatus: 'completed' | 'failed',
    providerReference: string | null,
  ): Promise<CashInOperationDocument | null> {
    const updated = await this.repository.updateStatusIfPending(
      operationId,
      newStatus,
      providerReference,
    );

    if (!updated) {
      this.logger.debug(
        `Ignored transition to "${newStatus}" for operation ${operationId}: no longer pending (duplicate or out-of-order event)`,
      );
      return null;
    }

    this.logger.log(`Operation ${operationId} transitioned to "${newStatus}"`);

    if (newStatus === 'completed') {
      await this.walletService.creditBalance(userId, amount);
      this.logger.log(`Credited ${amount} to wallet for user ${userId}`);
    }

    return updated;
  }
}

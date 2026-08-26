import { Injectable } from '@nestjs/common';
import { WalletService } from '../wallet/wallet.service';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { CashInOperationDocument } from './schemas/cash-in-operation.schema';
import { ContextualLogger } from '../common/logger/contextual-logger';

export interface TransitionResult {
  operation: CashInOperationDocument;
  /**
   * Balance exactly as returned by the atomic $inc that credited it — not a
   * separate read afterwards, which could race with another concurrent
   * operation on the same wallet and report a stale/wrong-moment value.
   * Present only when this call actually credited the wallet.
   */
  balanceAfterCredit: number | null;
}

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
  ): Promise<TransitionResult | null> {
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

    let balanceAfterCredit: number | null = null;
    if (newStatus === 'completed') {
      balanceAfterCredit = await this.walletService.creditBalance(
        userId,
        amount,
      );
      this.logger.log(`Credited ${amount} to wallet for user ${userId}`);
    }

    return { operation: updated, balanceAfterCredit };
  }
}

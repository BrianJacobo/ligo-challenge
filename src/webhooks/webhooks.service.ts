import { Injectable, Logger } from '@nestjs/common';
import { CashInOperationRepository } from '../cash-in/cash-in-operation.repository';
import { OperationTransitionService } from '../cash-in/operation-transition.service';
import { PendingWebhookRepository } from './pending-webhook.repository';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';

export interface WebhookAckResult {
  received: true;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly operationRepository: CashInOperationRepository,
    private readonly transitionService: OperationTransitionService,
    private readonly pendingWebhookRepository: PendingWebhookRepository,
  ) {}

  async handlePaymentWebhook(dto: PaymentWebhookDto): Promise<WebhookAckResult> {
    const newStatus: 'completed' | 'failed' =
      dto.status === 'success' ? 'completed' : 'failed';
    const providerReference = dto.provider_reference ?? null;

    const operation = await this.operationRepository.findByOperationId(dto.operation_id);

    if (!operation) {
      // Sync POST /cash-in insert for this operation hasn't landed yet — buffer
      // it. CashInService drains this buffer right after the insert (plan.md,
      // "Flujo: POST /webhooks/payment", paso 3).
      this.logger.log(
        `Buffering webhook for unknown operation ${dto.operation_id} (arrived early)`,
      );
      await this.pendingWebhookRepository.buffer({
        operationId: dto.operation_id,
        status: newStatus,
        providerReference,
      });
      return { received: true };
    }

    // Conditional transition handles duplicates and out-of-order delivery as a
    // no-op: if the operation is no longer "pending", resolve() returns null and
    // nothing else happens (never re-credits, never overwrites a terminal state).
    await this.transitionService.resolve(
      operation.operationId,
      operation.userId,
      operation.amount,
      newStatus,
      providerReference,
    );

    return { received: true };
  }
}

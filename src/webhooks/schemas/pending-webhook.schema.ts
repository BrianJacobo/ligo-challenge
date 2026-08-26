import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PendingWebhookDocument = HydratedDocument<PendingWebhook>;

// If POST /cash-in never creates the matching operation (bad data, broken
// integration, wrong operationId from the provider), the buffered webhook would
// otherwise sit here forever. A generous TTL — far longer than any real race
// window — bounds that growth without risking a legitimate late drain.
const PENDING_WEBHOOK_TTL_SECONDS = 24 * 60 * 60;

/**
 * Buffer for webhooks that arrive before the corresponding operation exists in
 * cash_in_operations (the synchronous POST /cash-in insert hasn't completed yet).
 * Drained by CashInService right after it inserts the operation.
 */
@Schema({ collection: 'pending_webhooks' })
export class PendingWebhook {
  @Prop({ required: true, unique: true })
  operationId: string;

  @Prop({ required: true, enum: ['completed', 'failed'] })
  status: 'completed' | 'failed';

  @Prop({ type: String, default: null })
  providerReference: string | null;

  @Prop({
    required: true,
    default: () => new Date(),
    expires: PENDING_WEBHOOK_TTL_SECONDS,
  })
  receivedAt: Date;
}

export const PendingWebhookSchema =
  SchemaFactory.createForClass(PendingWebhook);

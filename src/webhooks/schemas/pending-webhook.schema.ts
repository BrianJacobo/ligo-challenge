import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PendingWebhookDocument = HydratedDocument<PendingWebhook>;

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

  @Prop({ required: true, default: () => new Date() })
  receivedAt: Date;
}

export const PendingWebhookSchema = SchemaFactory.createForClass(PendingWebhook);

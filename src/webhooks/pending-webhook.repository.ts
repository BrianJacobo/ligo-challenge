import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PendingWebhook,
  PendingWebhookDocument,
} from './schemas/pending-webhook.schema';

export interface BufferWebhookInput {
  operationId: string;
  status: 'completed' | 'failed';
  providerReference: string | null;
}

@Injectable()
export class PendingWebhookRepository {
  constructor(
    @InjectModel(PendingWebhook.name)
    private readonly model: Model<PendingWebhookDocument>,
  ) {}

  /** Upsert so a resent/duplicate early webhook doesn't create multiple buffer entries. */
  buffer(input: BufferWebhookInput): Promise<void> {
    return this.model
      .updateOne(
        { operationId: input.operationId },
        {
          $set: {
            status: input.status,
            providerReference: input.providerReference,
            receivedAt: new Date(),
          },
        },
        { upsert: true },
      )
      .exec()
      .then(() => undefined);
  }

  async takeByOperationId(operationId: string): Promise<PendingWebhookDocument | null> {
    return this.model.findOneAndDelete({ operationId }).exec();
  }
}

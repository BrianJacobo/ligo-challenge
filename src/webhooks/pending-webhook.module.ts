import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PendingWebhook,
  PendingWebhookSchema,
} from './schemas/pending-webhook.schema';
import { PendingWebhookRepository } from './pending-webhook.repository';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PendingWebhook.name, schema: PendingWebhookSchema },
    ]),
  ],
  providers: [PendingWebhookRepository],
  exports: [PendingWebhookRepository],
})
export class PendingWebhookModule {}

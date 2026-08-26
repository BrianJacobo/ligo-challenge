import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { CashInModule } from '../cash-in/cash-in.module';
import { PendingWebhookModule } from './pending-webhook.module';

@Module({
  imports: [CashInModule, PendingWebhookModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}

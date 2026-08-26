import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashInOperation, CashInOperationSchema } from './schemas/cash-in-operation.schema';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { CashInController } from './cash-in.controller';
import { CashInService } from './cash-in.service';
import { OperationTransitionService } from './operation-transition.service';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentProviderModule } from '../payment-provider/payment-provider.module';
import { PendingWebhookModule } from '../webhooks/pending-webhook.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashInOperation.name, schema: CashInOperationSchema },
    ]),
    IdempotencyModule,
    WalletModule,
    PaymentProviderModule,
    PendingWebhookModule,
  ],
  controllers: [CashInController],
  providers: [CashInOperationRepository, CashInService, OperationTransitionService],
  exports: [CashInOperationRepository, OperationTransitionService],
})
export class CashInModule {}

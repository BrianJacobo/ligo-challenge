import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashInOperation, CashInOperationSchema } from './schemas/cash-in-operation.schema';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { CashInController } from './cash-in.controller';
import { CashInService } from './cash-in.service';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentProviderModule } from '../payment-provider/payment-provider.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashInOperation.name, schema: CashInOperationSchema },
    ]),
    IdempotencyModule,
    WalletModule,
    PaymentProviderModule,
  ],
  controllers: [CashInController],
  providers: [CashInOperationRepository, CashInService],
  exports: [CashInOperationRepository],
})
export class CashInModule {}

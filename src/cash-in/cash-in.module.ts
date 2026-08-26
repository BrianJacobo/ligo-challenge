import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashInOperation, CashInOperationSchema } from './schemas/cash-in-operation.schema';
import { CashInOperationRepository } from './cash-in-operation.repository';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashInOperation.name, schema: CashInOperationSchema },
    ]),
  ],
  providers: [CashInOperationRepository],
  exports: [CashInOperationRepository],
})
export class CashInModule {}

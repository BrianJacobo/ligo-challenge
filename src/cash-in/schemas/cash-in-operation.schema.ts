import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CashInOperationStatus = 'pending' | 'completed' | 'failed';

export type CashInOperationDocument = HydratedDocument<CashInOperation>;

@Schema({ timestamps: true, collection: 'cash_in_operations' })
export class CashInOperation {
  @Prop({ required: true, unique: true })
  operationId: string;

  @Prop({ required: true, unique: true })
  idempotencyKey: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string;

  @Prop({ required: true })
  paymentMethod: string;

  @Prop({
    required: true,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending',
  })
  status: CashInOperationStatus;

  @Prop({ type: String, default: null })
  providerReference: string | null;

  @Prop({ required: true })
  requestHash: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const CashInOperationSchema =
  SchemaFactory.createForClass(CashInOperation);

// operationId and idempotencyKey unique indexes are declared via @Prop({ unique: true }) above.
CashInOperationSchema.index({ userId: 1, createdAt: -1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WalletDocument = HydratedDocument<Wallet>;

@Schema({ timestamps: true, collection: 'wallets' })
export class Wallet {
  @Prop({ required: true, unique: true })
  userId: string;

  @Prop({ required: true, default: 0 })
  balance: number;

  updatedAt?: Date;
}

export const WalletSchema = SchemaFactory.createForClass(Wallet);

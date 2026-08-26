import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from './schemas/wallet.schema';

@Injectable()
export class WalletService {
  constructor(
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
  ) {}

  /**
   * Atomic credit via $inc — never read-modify-write in application code.
   * Safe under concurrent credits to the same wallet from different operations.
   */
  async creditBalance(userId: string, amount: number): Promise<number> {
    const wallet = await this.walletModel
      .findOneAndUpdate(
        { userId },
        { $inc: { balance: amount } },
        { returnDocument: 'after', upsert: true },
      )
      .exec();

    return wallet.balance;
  }

  async getBalance(userId: string): Promise<number> {
    const wallet = await this.walletModel.findOne({ userId }).exec();
    return wallet?.balance ?? 0;
  }
}

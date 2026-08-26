import { Model } from 'mongoose';
import { WalletDocument } from '../../src/wallet/schemas/wallet.schema';

/** Creates (or resets) a wallet with a known starting balance for e2e/integration tests. */
export async function seedWallet(
  walletModel: Model<WalletDocument>,
  userId: string,
  initialBalance = 250.0,
): Promise<void> {
  await walletModel.findOneAndUpdate(
    { userId },
    { $set: { balance: initialBalance } },
    { upsert: true },
  );
}

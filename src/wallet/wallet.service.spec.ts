import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import { WalletService } from './wallet.service';

const MONGO_URI =
  process.env.MONGO_URI_TEST ?? 'mongodb://localhost:27017/ligo-cash-in-test';

describe('WalletService', () => {
  let service: WalletService;
  let connection: Connection;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI),
        MongooseModule.forFeature([{ name: Wallet.name, schema: WalletSchema }]),
      ],
      providers: [WalletService],
    }).compile();

    service = moduleRef.get(WalletService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterEach(async () => {
    await connection.collection('wallets').deleteMany({});
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await moduleRef.close();
  });

  it('creates a wallet on first credit (upsert) starting from the credited amount', async () => {
    const balance = await service.creditBalance('usr_1', 100);
    expect(balance).toBe(100);
  });

  it('credits atomically on top of an existing balance', async () => {
    await service.creditBalance('usr_1', 250);
    const balance = await service.creditBalance('usr_1', 100);
    expect(balance).toBe(350);
  });

  it('applies concurrent credits without lost updates ($inc is atomic)', async () => {
    await service.creditBalance('usr_concurrent', 0);

    await Promise.all(
      Array.from({ length: 10 }, () => service.creditBalance('usr_concurrent', 10)),
    );

    const finalBalance = await service.getBalance('usr_concurrent');
    expect(finalBalance).toBe(100);
  });

  it('getBalance returns 0 for a user without a wallet', async () => {
    const balance = await service.getBalance('unknown_user');
    expect(balance).toBe(0);
  });
});

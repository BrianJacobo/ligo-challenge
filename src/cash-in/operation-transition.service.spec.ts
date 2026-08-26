import { Test, TestingModule } from '@nestjs/testing';
import {
  MongooseModule,
  getConnectionToken,
  getModelToken,
} from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  CashInOperation,
  CashInOperationDocument,
  CashInOperationSchema,
} from './schemas/cash-in-operation.schema';
import { Wallet, WalletSchema } from '../wallet/schemas/wallet.schema';
import { CashInOperationRepository } from './cash-in-operation.repository';
import { OperationTransitionService } from './operation-transition.service';
import { WalletService } from '../wallet/wallet.service';

// Each spec file gets its own database — see note in cash-in-operation.repository.spec.ts.
const MONGO_URI =
  process.env.MONGO_URI_TEST ??
  'mongodb://localhost:27017/ligo-cash-in-test-operation-transition';

describe('OperationTransitionService — balance reporting under concurrency', () => {
  let service: OperationTransitionService;
  let repository: CashInOperationRepository;
  let walletService: WalletService;
  let connection: Connection;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI),
        MongooseModule.forFeature([
          { name: CashInOperation.name, schema: CashInOperationSchema },
          { name: Wallet.name, schema: WalletSchema },
        ]),
      ],
      providers: [
        CashInOperationRepository,
        WalletService,
        OperationTransitionService,
      ],
    }).compile();

    repository = moduleRef.get(CashInOperationRepository);
    walletService = moduleRef.get(WalletService);
    service = moduleRef.get(OperationTransitionService);
    connection = moduleRef.get(getConnectionToken());

    const model = moduleRef.get<Model<CashInOperationDocument>>(
      getModelToken(CashInOperation.name),
    );
    await model.ensureIndexes();
  });

  afterEach(async () => {
    await connection.collection('cash_in_operations').deleteMany({});
    await connection.collection('wallets').deleteMany({});
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await moduleRef.close();
  });

  it('returns the balance exactly as credited by its own atomic $inc, never a separate stale read', async () => {
    const operation = await repository.insertPending({
      operationId: 'op_race_1',
      idempotencyKey: 'key_race_1',
      userId: 'usr_race',
      amount: 50,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      requestHash: 'hash_1',
    });

    // Fire a second, unrelated concurrent credit to the same wallet at the same
    // time as the transition below — the two $inc calls race, and either order
    // is valid. What must NEVER happen is resolve() reporting a balance that
    // doesn't correspond to either "50" (this op ran first) or "1050" (the
    // other op ran first) — e.g. a torn/stale read from a separate query.
    const [result] = await Promise.all([
      service.resolve(
        operation.operationId,
        'usr_race',
        50,
        'completed',
        'prov_1',
      ),
      walletService.creditBalance('usr_race', 1000),
    ]);

    expect([50, 1050]).toContain(result?.balanceAfterCredit);

    const finalBalance = await walletService.getBalance('usr_race');
    expect(finalBalance).toBe(1050);
  });

  it('reports null balanceAfterCredit when the transition is a no-op (already resolved)', async () => {
    const operation = await repository.insertPending({
      operationId: 'op_noop_1',
      idempotencyKey: 'key_noop_1',
      userId: 'usr_noop',
      amount: 20,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      requestHash: 'hash_2',
    });

    await service.resolve(
      operation.operationId,
      'usr_noop',
      20,
      'completed',
      'prov_1',
    );

    // Second attempt: the operation is no longer "pending" — no-op, no re-credit.
    const second = await service.resolve(
      operation.operationId,
      'usr_noop',
      20,
      'failed',
      'prov_2',
    );

    expect(second).toBeNull();

    const balance = await walletService.getBalance('usr_noop');
    expect(balance).toBe(20);
  });
});

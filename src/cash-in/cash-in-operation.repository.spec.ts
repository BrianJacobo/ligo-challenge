import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  CashInOperation,
  CashInOperationDocument,
  CashInOperationSchema,
} from './schemas/cash-in-operation.schema';
import {
  CashInOperationRepository,
  DuplicateIdempotencyKeyError,
} from './cash-in-operation.repository';

// Each spec file gets its own database — Jest runs suites as separate workers in
// parallel, and sharing a DB means one suite's dropDatabase() (afterAll) can wipe
// indexes/data out from under another suite still running.
const MONGO_URI =
  process.env.MONGO_URI_TEST ??
  'mongodb://localhost:27017/ligo-cash-in-test-cash-in-operation-repository';

describe('CashInOperationRepository', () => {
  let repository: CashInOperationRepository;
  let connection: Connection;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI),
        MongooseModule.forFeature([
          { name: CashInOperation.name, schema: CashInOperationSchema },
        ]),
      ],
      providers: [CashInOperationRepository],
    }).compile();

    repository = moduleRef.get(CashInOperationRepository);
    connection = moduleRef.get(getConnectionToken());

    // Mongoose builds indexes asynchronously in the background on connect;
    // without waiting for them, the unique-index tests below would be flaky.
    const model = moduleRef.get<Model<CashInOperationDocument>>(
      getModelToken(CashInOperation.name),
    );
    await model.ensureIndexes();
  });

  afterEach(async () => {
    await connection.collection('cash_in_operations').deleteMany({});
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await moduleRef.close();
  });

  const baseInput = {
    operationId: 'op_1',
    idempotencyKey: 'key_1',
    userId: 'usr_1',
    amount: 100,
    currency: 'PEN',
    paymentMethod: 'card_xyz',
    requestHash: 'hash_1',
  };

  it('inserts a new pending operation', async () => {
    const doc = await repository.insertPending(baseInput);

    expect(doc.status).toBe('pending');
    expect(doc.providerReference).toBeNull();
  });

  it('rejects a second insert with the same idempotencyKey', async () => {
    await repository.insertPending(baseInput);

    await expect(
      repository.insertPending({ ...baseInput, operationId: 'op_2' }),
    ).rejects.toThrow(DuplicateIdempotencyKeyError);
  });

  it('transitions pending -> completed exactly once', async () => {
    await repository.insertPending(baseInput);

    const first = await repository.updateStatusIfPending(
      baseInput.operationId,
      'completed',
      'prov_ref_1',
    );
    expect(first?.status).toBe('completed');

    // Second attempt to transition (e.g. duplicate/out-of-order webhook) is a no-op.
    const second = await repository.updateStatusIfPending(
      baseInput.operationId,
      'failed',
      'prov_ref_2',
    );
    expect(second).toBeNull();

    const stored = await repository.findByOperationId(baseInput.operationId);
    expect(stored?.status).toBe('completed');
    expect(stored?.providerReference).toBe('prov_ref_1');
  });

  it('findByIdempotencyKey returns null when not found', async () => {
    const result = await repository.findByIdempotencyKey('does-not-exist');
    expect(result).toBeNull();
  });
});

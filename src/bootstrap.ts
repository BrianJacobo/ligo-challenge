import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CashInOperation,
  CashInOperationDocument,
} from './cash-in/schemas/cash-in-operation.schema';
import { Wallet, WalletDocument } from './wallet/schemas/wallet.schema';
import {
  PendingWebhook,
  PendingWebhookDocument,
} from './webhooks/schemas/pending-webhook.schema';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';

/**
 * Shared app configuration used by both the real entrypoint (main.ts) and the
 * e2e test helper, so tests exercise exactly the same setup as production
 * instead of a hand-maintained copy that can drift out of sync.
 */
export async function configureApp(app: INestApplication): Promise<void> {
  app.useGlobalInterceptors(new CorrelationIdInterceptor());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Mongoose builds indexes in the background on connect and does NOT block
  // writes on them by default. The unique index on idempotencyKey is the
  // final guarantee against double-charging, so this pod must not accept
  // traffic until every unique index used by the domain is confirmed to exist
  // — not just the cash-in one, since Wallet.userId and
  // PendingWebhook.operationId are also relied upon for correctness (single
  // wallet per user, single buffered webhook per operation).
  const modelsToVerify: Model<unknown>[] = [
    app.get<Model<CashInOperationDocument>>(
      getModelToken(CashInOperation.name),
    ),
    app.get<Model<WalletDocument>>(getModelToken(Wallet.name)),
    app.get<Model<PendingWebhookDocument>>(getModelToken(PendingWebhook.name)),
  ];

  await Promise.all(modelsToVerify.map((model) => model.ensureIndexes()));
}

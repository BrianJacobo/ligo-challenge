import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CashInOperation,
  CashInOperationDocument,
} from './cash-in/schemas/cash-in-operation.schema';
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
  // traffic until it's confirmed to exist.
  const cashInModel = app.get<Model<CashInOperationDocument>>(
    getModelToken(CashInOperation.name),
  );
  await cashInModel.ensureIndexes();
}

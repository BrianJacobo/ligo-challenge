import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../../src/app.module';
import {
  CashInOperation,
  CashInOperationDocument,
} from '../../src/cash-in/schemas/cash-in-operation.schema';

/** Mirrors the production bootstrap in src/main.ts so e2e tests exercise the same setup. */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

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

  await app.init();

  const cashInModel = app.get<Model<CashInOperationDocument>>(
    getModelToken(CashInOperation.name),
  );
  await cashInModel.ensureIndexes();

  return app;
}

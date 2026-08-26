import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from './app.module';
import {
  CashInOperation,
  CashInOperationDocument,
} from './cash-in/schemas/cash-in-operation.schema';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

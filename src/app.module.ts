import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CashInModule } from './cash-in/cash-in.module';
import { WalletModule } from './wallet/wallet.module';
import { PaymentProviderModule } from './payment-provider/payment-provider.module';
import { IdempotencyModule } from './idempotency/idempotency.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>('MONGO_URI'),
      }),
    }),
    CashInModule,
    WalletModule,
    PaymentProviderModule,
    IdempotencyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

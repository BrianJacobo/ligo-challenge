import { Module } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { PaymentProviderMockService } from './payment-provider-mock.service';

@Module({
  providers: [
    { provide: PAYMENT_PROVIDER, useClass: PaymentProviderMockService },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}

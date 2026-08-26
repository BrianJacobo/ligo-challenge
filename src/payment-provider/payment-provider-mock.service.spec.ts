import { PaymentProviderMockService } from './payment-provider-mock.service';
import { PaymentProviderTimeoutError } from './payment-provider.interface';

describe('PaymentProviderMockService', () => {
  let service: PaymentProviderMockService;

  beforeEach(() => {
    service = new PaymentProviderMockService();
  });

  it('returns success with a providerReference for a normal payment method', async () => {
    const result = await service.charge({
      amount: 100,
      currency: 'PEN',
      paymentMethod: 'card_xyz',
    });

    expect(result.outcome).toBe('success');
    expect(result.providerReference).toBeDefined();
  });

  it('returns failure for paymentMethod "card_force_failure"', async () => {
    const result = await service.charge({
      amount: 100,
      currency: 'PEN',
      paymentMethod: 'card_force_failure',
    });

    expect(result.outcome).toBe('failure');
    expect(result.providerReference).toBeUndefined();
  });

  it('throws PaymentProviderTimeoutError for paymentMethod "card_force_timeout"', async () => {
    await expect(
      service.charge({
        amount: 100,
        currency: 'PEN',
        paymentMethod: 'card_force_timeout',
      }),
    ).rejects.toThrow(PaymentProviderTimeoutError);
  });

  it('generates distinct providerReferences across calls', async () => {
    const [first, second] = await Promise.all([
      service.charge({ amount: 10, currency: 'PEN', paymentMethod: 'card_a' }),
      service.charge({ amount: 10, currency: 'PEN', paymentMethod: 'card_b' }),
    ]);

    expect(first.providerReference).not.toBe(second.providerReference);
  });
});

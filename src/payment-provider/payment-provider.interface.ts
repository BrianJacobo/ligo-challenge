export type PaymentProviderOutcome = 'success' | 'failure' | 'timeout';

export interface PaymentProviderChargeInput {
  amount: number;
  currency: string;
  paymentMethod: string;
}

export interface PaymentProviderResult {
  outcome: PaymentProviderOutcome;
  providerReference?: string;
}

/**
 * Thrown when the provider does not respond in time. The caller cannot know
 * whether the charge actually happened — it must NOT assume success or failure.
 */
export class PaymentProviderTimeoutError extends Error {
  constructor() {
    super('Payment provider request timed out');
    this.name = 'PaymentProviderTimeoutError';
  }
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface PaymentProvider {
  charge(input: PaymentProviderChargeInput): Promise<PaymentProviderResult>;
}

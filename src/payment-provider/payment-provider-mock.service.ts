import { Injectable } from '@nestjs/common';
import {
  PaymentProvider,
  PaymentProviderChargeInput,
  PaymentProviderResult,
  PaymentProviderTimeoutError,
} from './payment-provider.interface';

const FORCE_TIMEOUT_METHOD = 'card_force_timeout';
const FORCE_FAILURE_METHOD = 'card_force_failure';

const SIMULATED_LATENCY_MS = { min: 50, max: 200 };
const SIMULATED_TIMEOUT_MS = 300;

function randomLatency(): number {
  const { min, max } = SIMULATED_LATENCY_MS;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-process mock of an external payment gateway. Outcome is driven explicitly
 * by `paymentMethod` so tests are deterministic — no reliance on real network
 * calls or randomness for the failure/timeout branches.
 */
@Injectable()
export class PaymentProviderMockService implements PaymentProvider {
  async charge(input: PaymentProviderChargeInput): Promise<PaymentProviderResult> {
    if (input.paymentMethod === FORCE_TIMEOUT_METHOD) {
      await delay(SIMULATED_TIMEOUT_MS);
      throw new PaymentProviderTimeoutError();
    }

    if (input.paymentMethod === FORCE_FAILURE_METHOD) {
      await delay(randomLatency());
      return { outcome: 'failure' };
    }

    await delay(randomLatency());
    return {
      outcome: 'success',
      providerReference: `prov_${Math.random().toString(36).slice(2, 10)}`,
    };
  }
}

import { config } from '../config.ts';
import { MockPayPal } from './mock.ts';
import { RestPayPal } from './rest.ts';
import type { PayPalProvider } from './types.ts';

export const mockPayPal = new MockPayPal();
const restPayPal = new RestPayPal();

/** Provider for new checkouts, following PAYPAL_MODE. */
export const checkoutProvider = (): PayPalProvider => (config.paypal.mode === 'mock' ? mockPayPal : restPayPal);

/** Provider that owns an existing commitment (seeded demo buyers stay simulated). */
export const providerFor = (name: 'paypal' | 'mock'): PayPalProvider => (name === 'mock' ? mockPayPal : restPayPal);

export * from './types.ts';

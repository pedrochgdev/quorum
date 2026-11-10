export type CreateOrderInput = {
  amount: number;
  currency: string;
  customId: string; // our commitment id
  referenceId: string; // our quorum id
  description: string;
  requestId: string;
  payeeEmail?: string | null; // send the money to this merchant account instead of the platform's
};

export type OrderResult = { id: string; status: string; approveUrl?: string };

export type AuthorizationResult = {
  authorizationId: string;
  status: string; // CREATED | CAPTURED | VOIDED | DENIED ...
  amount: number;
  payerEmail?: string;
  payerName?: string;
  expirationTime?: string;
};

export type CaptureResult = { captureId: string; status: string; amount: number };

export type PayoutItem = { email: string; amount: number; note: string; senderItemId: string };

export interface PayPalProvider {
  readonly name: 'paypal' | 'mock';
  createOrder(input: CreateOrderInput): Promise<OrderResult>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult>;
  getAuthorization(authorizationId: string): Promise<AuthorizationResult>;
  captureAuthorization(authorizationId: string, amount: number, currency: string, requestId: string): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<{ status: string }>;
  reauthorize(authorizationId: string, amount: number, currency: string, requestId: string): Promise<AuthorizationResult>;
  refundCapture(captureId: string, amount: number, currency: string, requestId: string): Promise<{ refundId: string; status: string }>;
  createPayout(items: PayoutItem[], currency: string, requestId: string): Promise<{ batchId: string; status: string }>;
}

export class PayPalError extends Error {
  status: number;
  details: unknown;
  issue?: string;
  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    const d = details as { details?: { issue?: string }[]; name?: string } | undefined;
    this.issue = d?.details?.[0]?.issue ?? d?.name;
  }
}

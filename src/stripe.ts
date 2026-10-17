// Minimal Stripe wrapper over the raw HTTPS API (no SDK dependency).
// If STRIPE_SECRET_KEY is not set, every operation throws STRIPE_NOT_CONFIGURED
// — an honest business error, never a simulated success.
import { biz, STRIPE_NOT_CONFIGURED, STRIPE_ERROR } from './errors.js';

const KEY = process.env.STRIPE_SECRET_KEY ?? '';

export function stripeConfigured(): boolean {
  return KEY.length > 10;
}

async function stripePost(path: string, params: Record<string, string>): Promise<any> {
  if (!stripeConfigured()) biz(STRIPE_NOT_CONFIGURED);
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) biz(STRIPE_ERROR, json?.error?.message ?? `stripe ${res.status}`);
  return json;
}

async function stripeGet(path: string): Promise<any> {
  if (!stripeConfigured()) biz(STRIPE_NOT_CONFIGURED);
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) biz(STRIPE_ERROR, json?.error?.message ?? `stripe ${res.status}`);
  return json;
}

export async function createCheckoutSession(opts: {
  customerEmail: string;
  amountCents: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}): Promise<{ id: string; url: string | null }> {
  const params: Record<string, string> = {
    mode: 'payment',
    customer_email: opts.customerEmail,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    'line_items[0][price_data][currency]': opts.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(opts.amountCents),
    'line_items[0][price_data][product_data][name]': opts.description,
    'line_items[0][quantity]': '1',
  };
  for (const [k, v] of Object.entries(opts.metadata)) params[`metadata[${k}]`] = v;
  const s = await stripePost('/checkout/sessions', params);
  return { id: s.id, url: s.url ?? null };
}

export async function retrieveCheckoutSession(id: string): Promise<any> {
  return stripeGet(`/checkout/sessions/${encodeURIComponent(id)}`);
}

export async function createRefund(paymentIntentId: string): Promise<any> {
  return stripePost('/refunds', { payment_intent: paymentIntentId, reason: 'requested_by_customer' });
}

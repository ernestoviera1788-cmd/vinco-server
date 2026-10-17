// Premium/commerce actions: plans, boosts, Stripe checkout, billing history,
// subscription renewal, end-of-cycle cancellation, and refund requests.
//
// Nothing is simulated: without STRIPE_SECRET_KEY every Stripe call throws
// STRIPE_NOT_CONFIGURED, and pending payments are marked 'failed' if the
// Stripe call itself fails.
import { query, queryOne, tx } from '../db.js';
import {
  biz,
  STRIPE_NOT_CONFIGURED,
  PLAN_NOT_FOUND,
  BOOST_NOT_FOUND,
  INVALID_CHECKOUT_KIND,
  CHECKOUT_SESSION_NOT_FOUND,
  SUBSCRIPTION_NOT_FOUND,
  PAYMENT_NOT_FOUND,
  REFUND_ALREADY_REQUESTED,
  INVALID_REFUND_REASON,
  INVALID_CONFIRM,
} from '../errors.js';
import { registerAction, type ActionContext } from '../rpc.js';
import { reqEnum, reqString, reqBoolean } from '../validation.js';
import { stripeConfigured, createCheckoutSession, retrieveCheckoutSession } from '../stripe.js';
import { notifyUser } from '../notify.js';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

// ---- row mappers (DB snake_case -> API camelCase) ----

function planRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    interval: r.interval,
    priceCents: r.price_cents,
    currency: r.currency,
    benefits: r.benefits ?? [],
  };
}

function boostRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    priceCents: r.price_cents,
    currency: r.currency,
    durationMinutes: r.duration_minutes,
  };
}

function paymentRow(r: any) {
  return {
    id: r.id,
    kind: r.kind,
    itemId: r.item_id,
    amountCents: r.amount_cents,
    currency: r.currency,
    status: r.status,
    createdAt: r.created_at,
  };
}

function subscriptionRow(r: any) {
  return {
    id: r.id,
    planId: r.plan_id,
    planName: r.plan_name ?? null,
    interval: r.interval ?? null,
    status: r.status,
    currentPeriodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
    createdAt: r.created_at,
  };
}

function userBoostRow(r: any) {
  return {
    id: r.id,
    boostId: r.boost_id,
    name: r.boost_name ?? null,
    status: r.status,
    activatedAt: r.activated_at,
    expiresAt: r.expires_at,
  };
}

// Days per billing interval (spec: monthly +30d, quarterly +90d, annual +365d).
function intervalDays(interval: string): number {
  if (interval === 'quarterly') return 90;
  if (interval === 'annual') return 365;
  return 30;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86400_000);
}

// ---- actions ----

// Public catalog: active subscription plans.
registerAction(
  'listplans',
  async () => {
    const rows = await query(
      `SELECT * FROM subscription_plans WHERE active = TRUE ORDER BY price_cents ASC`
    );
    return { plans: rows.map(planRow) };
  },
  { auth: 'none' }
);

// Public catalog: active boosts.
registerAction(
  'listboosts',
  async () => {
    const rows = await query(`SELECT * FROM boosts WHERE active = TRUE ORDER BY price_cents ASC`);
    return { boosts: rows.map(boostRow) };
  },
  { auth: 'none' }
);

// Create a pending payment and a Stripe Checkout session for it.
// Returns the hosted Checkout URL to open in a browser.
registerAction(
  'createcheckout',
  async (args, ctx: ActionContext) => {
    const user = ctx.user!;
    const kind = reqEnum(args, 'kind', ['SUBSCRIPTION', 'BOOST'] as const);
    const itemId = reqString(args, 'itemId', 1, 100);

    let item: any;
    if (kind === 'SUBSCRIPTION') {
      item = await queryOne(`SELECT * FROM subscription_plans WHERE id = $1 AND active = TRUE`, [
        itemId,
      ]);
      if (!item) biz(PLAN_NOT_FOUND);
    } else {
      item = await queryOne(`SELECT * FROM boosts WHERE id = $1 AND active = TRUE`, [itemId]);
      if (!item) biz(BOOST_NOT_FOUND);
    }

    if (!stripeConfigured()) biz(STRIPE_NOT_CONFIGURED);

    const payment = await queryOne(
      `INSERT INTO payments (id, user_id, kind, item_id, amount_cents, currency, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [user.id, kind, itemId, item.price_cents, item.currency]
    );
    try {
      const session = await createCheckoutSession({
        customerEmail: user.email,
        amountCents: item.price_cents,
        currency: item.currency,
        description: kind === 'SUBSCRIPTION' ? `VINCÓ Premium — ${item.name}` : `VINCÓ — ${item.name}`,
        successUrl: `${PUBLIC_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${PUBLIC_BASE_URL}/billing/cancel`,
        metadata: { paymentId: payment!.id, kind, itemId, userId: user.id },
      });
      await query(`UPDATE payments SET stripe_session_id = $1 WHERE id = $2`, [
        session.id,
        payment!.id,
      ]);
      return { paymentId: payment!.id, sessionId: session.id, url: session.url };
    } catch (e) {
      // No simulated success: the pending payment is parked as failed so it
      // can never be confirmed later.
      await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment!.id]);
      throw e;
    }
  },
  { auth: 'user' }
);

// Confirm a Stripe Checkout session: marks the payment completed and grants
// the purchased entitlement (subscription or boost). Idempotent.
registerAction(
  'confirmcheckout',
  async (args, ctx: ActionContext) => {
    const user = ctx.user!;
    const sessionId = reqString(args, 'sessionId', 1, 200);

    const payment = await queryOne(
      `SELECT * FROM payments WHERE stripe_session_id = $1 AND user_id = $2`,
      [sessionId, user.id]
    );
    if (!payment) biz(CHECKOUT_SESSION_NOT_FOUND);

    // Idempotent re-confirm: already granted, nothing to do.
    if (payment.status === 'completed') return { ok: true, paid: true, payment: paymentRow(payment) };

    const session: any = await retrieveCheckoutSession(sessionId);
    const paid = session?.payment_status === 'paid' || session?.status === 'complete';
    if (!paid) return { ok: true, paid: false };

    const result: any = await tx(async (client) => {
      const p = (
        await client.query(
          `UPDATE payments SET status = 'completed' WHERE id = $1 RETURNING *`,
          [payment.id]
        )
      ).rows[0];

      if (payment.kind === 'SUBSCRIPTION') {
        const plan = await client
          .query(`SELECT * FROM subscription_plans WHERE id = $1`, [payment.item_id])
          .then((r) => r.rows[0] ?? null);
        if (!plan) biz(PLAN_NOT_FOUND);
        const days = intervalDays(plan.interval);
        const existing = (
          await client.query(
            `SELECT * FROM subscriptions WHERE user_id = $1 AND plan_id = $2 AND status = 'active'
             ORDER BY created_at DESC LIMIT 1`,
            [user.id, payment.item_id]
          )
        ).rows[0] ?? null;
        const now = new Date();
        const base =
          existing && new Date(existing.current_period_end).getTime() > now.getTime()
            ? new Date(existing.current_period_end)
            : now;
        const periodEnd = addDays(base, days);
        let sub: any;
        if (existing) {
          sub = (
            await client.query(
              `UPDATE subscriptions
               SET status = 'active', cancel_at_period_end = FALSE, current_period_end = $1, updated_at = now()
               WHERE id = $2 RETURNING *`,
              [periodEnd.toISOString(), existing.id]
            )
          ).rows[0];
        } else {
          sub = (
            await client.query(
              `INSERT INTO subscriptions (id, user_id, plan_id, status, current_period_end, cancel_at_period_end)
               VALUES (gen_random_uuid(), $1, $2, 'active', $3, FALSE) RETURNING *`,
              [user.id, payment.item_id, periodEnd.toISOString()]
            )
          ).rows[0];
        }
        sub.plan_name = plan.name;
        sub.interval = plan.interval;
        return { payment: p, subscription: sub };
      }

      if (payment.kind === 'BOOST') {
        const boost = await client
          .query(`SELECT * FROM boosts WHERE id = $1`, [payment.item_id])
          .then((r) => r.rows[0] ?? null);
        if (!boost) biz(BOOST_NOT_FOUND);
        const expiresAt = addDays(new Date(), boost.duration_minutes / 1440);
        const ub = (
          await client.query(
            `INSERT INTO user_boosts (id, user_id, boost_id, payment_id, status, expires_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'active', $4) RETURNING *`,
            [user.id, payment.item_id, payment.id, expiresAt.toISOString()]
          )
        ).rows[0];
        ub.boost_name = boost.name;
        return { payment: p, boost: ub };
      }

      biz(INVALID_CHECKOUT_KIND);
    });

    await notifyUser(
      user.id,
      'subscription',
      payment.kind === 'SUBSCRIPTION' ? 'VINCÓ Premium activado' : 'Boost activado',
      payment.kind === 'SUBSCRIPTION'
        ? 'Tu suscripción premium está activa. ¡Buena suerte ahí fuera!'
        : 'Tu boost está activo: tu perfil aparecerá destacado.',
      { paymentId: payment.id, kind: payment.kind, itemId: payment.item_id }
    );

    const out: any = { ok: true, paid: true, payment: paymentRow(result.payment) };
    if (result.subscription) out.subscription = subscriptionRow(result.subscription);
    if (result.boost) out.boost = userBoostRow(result.boost);
    return out;
  },
  { auth: 'user' }
);

// Billing overview for the authenticated user.
registerAction(
  'listmybilling',
  async (_args, ctx: ActionContext) => {
    const user = ctx.user!;
    const [sub, payments, boosts] = await Promise.all([
      queryOne(
        `SELECT s.*, p.name AS plan_name, p.interval
         FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.user_id = $1 AND s.status = 'active'
         ORDER BY s.created_at DESC LIMIT 1`,
        [user.id]
      ),
      query(
        `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [user.id]
      ),
      query(
        `SELECT ub.*, b.name AS boost_name
         FROM user_boosts ub JOIN boosts b ON b.id = ub.boost_id
         WHERE ub.user_id = $1 ORDER BY ub.activated_at DESC LIMIT 50`,
        [user.id]
      ),
    ]);
    return {
      subscription: sub ? subscriptionRow(sub) : null,
      payments: payments.map(paymentRow),
      boosts: boosts.map(userBoostRow),
    };
  },
  { auth: 'user' }
);

// Extend the user's own ACTIVE subscription by its plan interval.
registerAction(
  'renewsubscription',
  async (args, ctx: ActionContext) => {
    const user = ctx.user!;
    const subscriptionId = reqString(args, 'subscriptionId', 1, 100);
    const sub = await queryOne(
      `SELECT s.*, p.name AS plan_name, p.interval
       FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.status = 'active'`,
      [subscriptionId, user.id]
    );
    if (!sub) biz(SUBSCRIPTION_NOT_FOUND);

    const now = new Date();
    const base =
      new Date(sub.current_period_end).getTime() > now.getTime()
        ? new Date(sub.current_period_end)
        : now;
    const periodEnd = addDays(base, intervalDays(sub.interval));
    const updated = await queryOne(
      `UPDATE subscriptions
       SET current_period_end = $1, cancel_at_period_end = FALSE, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [periodEnd.toISOString(), subscriptionId]
    );
    updated!.plan_name = sub.plan_name;
    updated!.interval = sub.interval;
    return subscriptionRow(updated);
  },
  { auth: 'user' }
);

// Mark the user's own subscription to cancel at the end of the current
// period (not immediately).
registerAction(
  'cancelsubscription',
  async (args, ctx: ActionContext) => {
    const user = ctx.user!;
    const subscriptionId = reqString(args, 'subscriptionId', 1, 100);
    const confirm = reqBoolean(args, 'confirm');
    if (!confirm) biz(INVALID_CONFIRM);

    const sub = await queryOne(
      `SELECT s.*, p.name AS plan_name, p.interval
       FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.status = 'active'`,
      [subscriptionId, user.id]
    );
    if (!sub) biz(SUBSCRIPTION_NOT_FOUND);

    const updated = await queryOne(
      `UPDATE subscriptions
       SET cancel_at_period_end = TRUE, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [subscriptionId]
    );
    updated!.plan_name = sub.plan_name;
    updated!.interval = sub.interval;
    return subscriptionRow(updated);
  },
  { auth: 'user' }
);

// Request a refund for the user's own completed payment (one per payment).
registerAction(
  'requestrefund',
  async (args, ctx: ActionContext) => {
    const user = ctx.user!;
    const paymentId = reqString(args, 'paymentId', 1, 100);
    const rawReason = args?.reason;
    if (
      typeof rawReason !== 'string' ||
      rawReason.trim().length < 8 ||
      rawReason.trim().length > 500
    ) {
      biz(INVALID_REFUND_REASON);
    }
    const reason = rawReason.trim();

    const payment = await queryOne(
      `SELECT * FROM payments WHERE id = $1 AND user_id = $2 AND status = 'completed'`,
      [paymentId, user.id]
    );
    if (!payment) biz(PAYMENT_NOT_FOUND);

    const existing = await queryOne(`SELECT id FROM payment_refunds WHERE payment_id = $1`, [
      paymentId,
    ]);
    if (existing) biz(REFUND_ALREADY_REQUESTED);

    const refund = await queryOne(
      `INSERT INTO payment_refunds (id, payment_id, user_id, reason, status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'requested') RETURNING *`,
      [paymentId, user.id, reason]
    );
    return { ok: true, refundId: refund!.id };
  },
  { auth: 'user' }
);

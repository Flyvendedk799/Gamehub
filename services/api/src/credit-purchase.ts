/**
 * Credit purchase port + mock provider (Phase 6.1).
 *
 * `CreditPurchaseProvider` is the seam the API buys credit packs through. The
 * dev default is `MockCreditProvider`, which "sells" a pack and immediately
 * returns a webhook-style confirmation carrying an external event id — no
 * Stripe/payment integration needed to run the purchase loop locally or in
 * tests. A real provider (Stripe Checkout + webhook) is a later swap behind the
 * same interface; the route's grant logic does not change.
 *
 * Idempotency: the grant is keyed on the provider's external event id and
 * reuses the EXISTING dormant partial-unique `credit_ledger_user_event_key` on
 * (user_id, stripe_event_id) via onConflictDoNothing — a double-fired webhook
 * grants the credits exactly once. The `stripe_event_id` column is repurposed
 * as the generic external event id (not renamed) so the constraint carries over.
 */
import { randomUUID } from 'node:crypto';
import { type CreditPack, creditPackById } from '@playforge/shared';

/** A confirmed purchase: the pack that was bought + the provider event id that
 *  makes the grant idempotent. */
export interface PurchaseConfirmation {
  /** The credit pack the user bought. */
  pack: CreditPack;
  /**
   * Provider-issued external event id (e.g. a Stripe `evt_…` id). Stored on the
   * ledger row as `stripe_event_id`; the partial-unique on (user_id, that)
   * dedupes a re-fired webhook.
   */
  externalEventId: string;
  /**
   * Where the client should go to complete payment. For the mock provider this
   * is a synthetic URL; the purchase is already confirmed (no real redirect).
   */
  checkoutUrl: string;
  /** True when credits were granted as part of this call (mock auto-confirms). */
  confirmed: boolean;
}

/** The purchase seam. Implementations turn a (userId, packId) into a confirmed
 *  (or pending) purchase the route then grants against the ledger. */
export interface CreditPurchaseProvider {
  /** Begin (and, for the mock, immediately confirm) a purchase. Returns null for
   *  an unknown pack id so the route can reply 400. */
  createPurchase(input: {
    userId: string;
    packId: string;
  }): Promise<PurchaseConfirmation | null>;
}

/**
 * Dev/default provider. Resolves the requested pack from the shared catalogue,
 * mints a synthetic external event id, and returns an immediately-confirmed
 * purchase. The route grants `pack.credits` to the ledger keyed on
 * `externalEventId`. NEVER use in production — no money changes hands.
 */
export class MockCreditProvider implements CreditPurchaseProvider {
  constructor(
    private readonly opts: {
      /** Inject a deterministic event id in tests; defaults to a random uuid. */
      eventIdFactory?: () => string;
    } = {},
  ) {}

  async createPurchase(input: {
    userId: string;
    packId: string;
  }): Promise<PurchaseConfirmation | null> {
    const pack = creditPackById(input.packId);
    if (!pack) return null;
    const externalEventId = (this.opts.eventIdFactory ?? randomUUID)();
    return {
      pack,
      externalEventId,
      checkoutUrl: `mock-checkout://playforge/${pack.id}?event=${encodeURIComponent(externalEventId)}`,
      confirmed: true,
    };
  }
}

/**
 * The platform's plans. Prices are monthly, in BZ$ before GST (the platform's
 * invoices add GST at the standard rate). Limits count documents issued in
 * the BTS production environment in a calendar month; test documents are
 * always free and unlimited.
 */

export type PlanCode = 'starter' | 'business' | 'pro';
export type Feature = 'store' | 'api' | 'webhooks' | 'integrations';

export interface Plan {
  code: PlanCode;
  name: string;
  /** Monthly price before GST, as a decimal string. */
  price: string;
  /** Production documents per calendar month; null for no limit. */
  documentsPerMonth: number | null;
  /** Active accounts; null for no limit. */
  users: number | null;
  features: readonly Feature[];
  blurb: string;
}

export const PLANS: Record<PlanCode, Plan> = {
  starter: {
    code: 'starter',
    name: 'Starter',
    price: '0',
    documentsPerMonth: 30,
    users: 2,
    features: [],
    blurb: 'For trying it out and very small sellers: invoices, receipts and the counter.',
  },
  business: {
    code: 'business',
    name: 'Business',
    price: '49.00',
    documentsPerMonth: 1000,
    users: 10,
    features: ['store', 'api'],
    blurb: 'For most shops: the online store, the API and up to 1,000 documents a month.',
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    price: '129.00',
    documentsPerMonth: null,
    users: null,
    features: ['store', 'api', 'webhooks', 'integrations'],
    blurb: 'For busy businesses: no limits, webhooks and accounting integrations.',
  },
};

export const PLAN_ORDER: readonly PlanCode[] = ['starter', 'business', 'pro'];
export const TRIAL_DAYS = 30;
/** Days to pay an invoice, then days overdue before issuing is paused. */
export const PAYMENT_TERMS_DAYS = 14;
export const SUSPEND_AFTER_OVERDUE_DAYS = 14;

export const isPlan = (v: string): v is PlanCode => v in PLANS;
export const hasFeature = (plan: PlanCode, feature: Feature) => PLANS[plan].features.includes(feature);

export const FEATURE_NAMES: Record<Feature, string> = {
  store: 'the online store',
  api: 'API keys',
  webhooks: 'webhooks',
  integrations: 'accounting integrations',
};

/** The cheapest plan that has a feature. */
export function planWith(feature: Feature): Plan {
  return PLANS[PLAN_ORDER.find((p) => hasFeature(p, feature))!];
}

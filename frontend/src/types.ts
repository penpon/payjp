// --- App state machine ---

export type AppState =
  | 'loading'
  | 'not_linked'
  | 'linked'
  | 'error'
  | 'billing'
  | 'register_complete'
  | 'cancel_complete'
  | 'cancel_error';

export interface SessionResponse {
  linked: boolean;
  /** Present when `linked` is true (Discord user bound to the current link session). */
  discordUserId?: string;
}

// --- Billing types ---

export type BillingStep = 'form' | 'submitting' | 'success' | 'error';

export interface PlanDef {
  id: string;
  name: string;
  price: number;
  features: string[];
}

export interface BillingFormState {
  step: BillingStep;
  selectedPlanId: string | null;
  email: string;
  cardholderName: string;
  privacyConsented: boolean;
  error: BillingError | null;
  result: SubscribeResponse | null;
}

export type BillingErrorKind =
  | 'session_expired'
  | 'forbidden_origin'
  | 'already_subscribed'
  | 'discord_not_member'
  | 'three_ds_failed'
  | 'card_invalid'
  | 'inflight'
  | 'server_error';

export interface BillingError {
  kind: BillingErrorKind;
  message: string;
  operationId?: string;
}

export interface SubscribeResponse {
  ok: true;
  memberId: string;
  subscriptionStatus: string;
  planId: string;
  trialApplied: boolean;
  accessEndAt: string;
}

export interface SubscriptionInfo {
  status: string;
  planId: string | null;
  accessEndAt: string | null;
}

// --- Cancel types ---

export interface CancelResponse {
  ok: true;
  memberId: string;
  cancelEffectiveAt: string;
  roleRemovalAt: string;
}

export type CancelErrorKind = 'no_subscription' | 'session_expired' | 'inflight' | 'server_error';

export interface CancelUIError {
  kind: CancelErrorKind;
  message: string;
  operationId?: string;
}

// --- PAY.JP.js v2 types ---

export interface PayjpCardElement {
  mount(target: string | HTMLElement): void;
  unmount(): void;
  clear(): void;
  on(event: 'change', handler: (e: PayjpChangeEvent) => void): void;
  on(event: 'ready' | 'focus' | 'blur', handler: () => void): void;
}

export interface PayjpChangeEvent {
  complete: boolean;
  error?: { code: string; message: string };
  brand?: string;
  empty: boolean;
}

export interface PayjpElements {
  create(type: 'card', options?: Record<string, unknown>): PayjpCardElement;
}

/** PAY.JP.js `createToken` の解決値 */
export type PayjpCreateTokenResult = {
  error?: { code: string; message: string };
  id?: string;
  card?: { three_d_secure_status?: string };
};

export interface PayjpInstance {
  elements(options?: { locale?: string }): PayjpElements;
  createToken(
    element: PayjpCardElement,
    data?: { three_d_secure?: boolean; card?: { name?: string; email?: string } },
    options?: { threeDSecureDialogOptions?: { timeout?: number } },
  ): Promise<PayjpCreateTokenResult>;
}

declare global {
  interface Window {
    Payjp?: (publicKey: string, options?: { threeDSecureWorkflow?: string }) => PayjpInstance;
  }
}

// --- PAY.JP adapter (for testability) ---

export interface PayjpAdapter {
  createCardElement(selector: string): PayjpCardElement;
  createToken(
    cardElement: PayjpCardElement,
    data: { name: string; email: string },
  ): Promise<{ tokenId?: string; error?: string }>;
}

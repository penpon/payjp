// --- App state machine ---

export type AppState = 'loading' | 'not_linked' | 'linked' | 'error' | 'billing';

export interface SessionResponse {
  linked: boolean;
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

export interface PayjpTokenResponse {
  id: string;
  card?: { three_d_secure_status?: string };
}

export interface PayjpInstance {
  elements(options?: { locale?: string }): PayjpElements;
  createToken(
    element: PayjpCardElement,
    data?: { card?: { name?: string; email?: string } },
    options?: { three_d_secure?: boolean; threeDSecureDialogOptions?: { timeout?: number } },
  ): Promise<{ error?: { code: string; message: string }; id?: string; card?: { three_d_secure_status?: string } }>;
}

declare global {
  interface Window {
    Payjp?: (publicKey: string, options?: { threeDSecureWorkflow?: string }) => PayjpInstance;
  }
}

// --- PAY.JP adapter (for testability) ---

export interface PayjpAdapter {
  createCardElement(mountTarget: HTMLElement): PayjpCardElement;
  createToken(
    cardElement: PayjpCardElement,
    data: { name: string; email: string },
  ): Promise<{ tokenId?: string; error?: string }>;
}

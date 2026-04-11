// --- App state machine ---

export type AppState =
  | 'loading'
  | 'linked'
  | 'error'
  | 'billing'
  | 'register_complete'
  | 'link_complete'
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

/** Mirrors `members.role_state` from GET /v1/members/me */
export type MemberRoleState = 'granted' | 'revoked' | 'unknown';

export interface MemberInfo {
  memberId: string;
  subscriptionStatus: string | null;
  planId: string | null;
  accessEndAt: string | null;
  discordLinked: boolean;
  roleState: MemberRoleState | null;
}

export interface LinkDiscordResponse {
  ok: boolean;
  discordUserId?: string;
  roleGranted?: boolean;
  errorCode?: string;
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

export interface CancelFormLinkResponse {
  ok: true;
  formUrl: string;
  expiresAt: string;
}

export type CancelErrorKind = 'no_subscription' | 'session_expired' | 'inflight' | 'server_error';

export interface CancelUIError {
  kind: CancelErrorKind;
  message: string;
  operationId?: string;
}

// --- PAY.JP.js v2 types ---

/** PAY.JP.js `Payjp()` 初期化時の 3Dセキュアワークフロー */
export type PayjpThreeDSecureWorkflow = 'iframe' | 'redirect' | 'subwindow';

export interface PayjpInitOptions {
  threeDSecureWorkflow?: PayjpThreeDSecureWorkflow;
}

/** サブウィンドウ型の `createToken` 第3引数で利用（iframe型では通常不要） */
export interface PayjpCreateTokenOptions {
  threeDSecureDialogOptions?: { timeout?: number; windowFeatures?: Record<string, unknown> };
}

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
  create(type: 'card' | 'cardNumber' | 'cardExpiry' | 'cardCvc', options?: Record<string, unknown>): PayjpCardElement;
}

export interface PayjpCardElements {
  cardNumber: PayjpCardElement;
  cardExpiry: PayjpCardElement;
  cardCvc: PayjpCardElement;
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
    options?: PayjpCreateTokenOptions,
  ): Promise<PayjpCreateTokenResult>;
}

declare global {
  interface Window {
    Payjp?: (publicKey: string, options?: PayjpInitOptions) => PayjpInstance;
  }
}

// --- PAY.JP adapter (for testability) ---

export interface PayjpAdapter {
  createCardElements(selectors: { cardNumber: string; cardExpiry: string; cardCvc: string }): PayjpCardElements;
  createToken(
    cardNumberElement: PayjpCardElement,
    data: { name: string; email: string },
  ): Promise<{ tokenId?: string; error?: string }>;
}

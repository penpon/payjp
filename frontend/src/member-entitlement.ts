import type { MemberInfo, SubscriptionInfo } from './types.js';

/** Align with billing `hasActiveSubscription`: paid entitlement only while canceled until access_end_at. */
export function memberHasActiveEntitlement(member: MemberInfo): boolean {
  const status = member.subscriptionStatus;
  const accessEnd = member.accessEndAt ? new Date(member.accessEndAt) : null;
  const now = new Date();
  if (status === 'active' || status === 'trial') return true;
  if (status === 'canceled' && accessEnd !== null && accessEnd > now) return true;
  return false;
}

/** When subscription status returns null but member still has canceled state (edge cases). */
export function buildSubscriptionForUi(
  member: MemberInfo,
  subscription: SubscriptionInfo | null,
): SubscriptionInfo | null {
  if (subscription) return subscription;
  if (member.subscriptionStatus === 'canceled' && memberHasActiveEntitlement(member)) {
    return {
      status: 'canceled',
      planId: member.planId,
      accessEndAt: member.accessEndAt,
    };
  }
  return null;
}

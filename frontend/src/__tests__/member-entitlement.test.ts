import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSubscriptionForUi, memberHasActiveEntitlement } from '../member-entitlement.js';
import type { MemberInfo } from '../types.js';

describe('memberHasActiveEntitlement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for canceled when access_end_at is in the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));

    const member: MemberInfo = {
      memberId: 'm1',
      subscriptionStatus: 'canceled',
      planId: 'plan_business',
      accessEndAt: '2026-05-01T00:00:00Z',
      discordLinked: true,
      roleState: 'revoked',
    };

    expect(memberHasActiveEntitlement(member)).toBe(true);
  });

  it('returns false for canceled when access_end_at is in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));

    const member: MemberInfo = {
      memberId: 'm1',
      subscriptionStatus: 'canceled',
      planId: 'plan_business',
      accessEndAt: '2026-04-11T00:00:00Z',
      discordLinked: true,
      roleState: 'revoked',
    };

    expect(memberHasActiveEntitlement(member)).toBe(false);
  });
});

describe('buildSubscriptionForUi', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when API subscription is null and canceled membership has expired access_end_at', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));

    const member: MemberInfo = {
      memberId: 'm1',
      subscriptionStatus: 'canceled',
      planId: 'plan_business',
      accessEndAt: '2026-04-11T00:00:00Z',
      discordLinked: true,
      roleState: 'revoked',
    };

    expect(buildSubscriptionForUi(member, null)).toBeNull();
  });

  it('synthesizes canceled subscription when API is null but grace period still applies', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));

    const member: MemberInfo = {
      memberId: 'm1',
      subscriptionStatus: 'canceled',
      planId: 'plan_business',
      accessEndAt: '2026-05-01T00:00:00Z',
      discordLinked: true,
      roleState: 'granted',
    };

    expect(buildSubscriptionForUi(member, null)).toEqual({
      status: 'canceled',
      planId: 'plan_business',
      accessEndAt: '2026-05-01T00:00:00Z',
    });
  });
});

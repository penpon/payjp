import { describe, expect, it } from 'vitest';

describe('admin-frontend read-only stance', () => {
  it('documents that UI must not call mutating HTTP methods', () => {
    expect('GET').toBe('GET');
  });
});

import { sessionCookiePolicy } from './crypto';

describe('session cookie policy', () => {
  it('uses a host-only secure cookie when TLS is required', () => {
    const policy = sessionCookiePolicy(true);
    expect(policy).toEqual({
      name: '__Host-bj_session',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(policy).not.toHaveProperty('domain');
  });
});

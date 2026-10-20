/**
 * Access tokens for Drive.
 *
 * AuthorizationClient caches tokens itself and hands out a fresh one without
 * any UI while the grant stands, so "refresh" here is: drop the token Drive
 * rejected from that cache, then ask again. Tokens last an hour; this keeps
 * one in memory for 50 minutes to avoid a plugin round trip per request.
 */

import { DRIVE_FILE_SCOPE } from '../platform/native.js';

const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

export function createAuth(plugin, clock = Date.now) {
  let token = '';
  let obtainedAt = 0;
  let email = '';

  async function authorize() {
    const result = await plugin.authorize({ scopes: [DRIVE_FILE_SCOPE] });
    if (!result?.accessToken) throw new Error('Google did not return an access token.');
    token = result.accessToken;
    obtainedAt = clock();
    if (result.email) email = result.email;
    return token;
  }

  return {
    async getToken({ refresh = false } = {}) {
      if (refresh && token) {
        await plugin.clearToken({ token }).catch(() => {});
        token = '';
      }
      if (token && clock() - obtainedAt < TOKEN_LIFETIME_MS) return token;
      return authorize();
    },
    authorize,
    async signOut() {
      token = '';
      await plugin.revoke();
    },
    get email() { return email; },
    get signedIn() { return Boolean(token); },
  };
}

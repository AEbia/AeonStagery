import type { CollaborationServerStatus } from '../../../server/collaboration/server';

export function authenticatedFetch(
  status: Pick<CollaborationServerStatus, 'accessToken'>,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${status.accessToken}`);
  return fetch(input, { ...init, headers });
}

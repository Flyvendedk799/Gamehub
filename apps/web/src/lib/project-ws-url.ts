import { getToken } from './auth';
import { API_WS_BASE } from './config';

export type ProjectWebSocketChannel = 'collab' | 'presence';

export function projectWebSocketUrl(
  baseWs: string,
  projectId: string,
  channel: ProjectWebSocketChannel,
  token: string | null,
): string {
  const url = new URL(
    `${baseWs}/v1/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(channel)}`,
  );
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export function authenticatedProjectWebSocketUrl(
  projectId: string,
  channel: ProjectWebSocketChannel,
): string {
  return projectWebSocketUrl(API_WS_BASE, projectId, channel, getToken());
}

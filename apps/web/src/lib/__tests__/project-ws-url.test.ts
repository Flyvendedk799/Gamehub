import { describe, expect, it } from 'vitest';
import { projectWebSocketUrl } from '../project-ws-url';

describe('projectWebSocketUrl', () => {
  it('adds the session token for authenticated project WebSockets', () => {
    expect(projectWebSocketUrl('ws://localhost:3191', 'project-1', 'presence', 'tok_123')).toBe(
      'ws://localhost:3191/v1/projects/project-1/presence?token=tok_123',
    );
  });

  it('omits the token query when no token exists', () => {
    expect(projectWebSocketUrl('ws://localhost:3191', 'project-1', 'collab', null)).toBe(
      'ws://localhost:3191/v1/projects/project-1/collab',
    );
  });

  it('encodes project ids and token values safely', () => {
    expect(projectWebSocketUrl('ws://localhost:3191', 'project/id', 'collab', 'tok+/=')).toBe(
      'ws://localhost:3191/v1/projects/project%2Fid/collab?token=tok%2B%2F%3D',
    );
  });
});

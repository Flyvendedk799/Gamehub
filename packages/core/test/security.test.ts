import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DoneToolSchema,
  SetTodosToolSchema,
  TextEditorToolSchema,
  createToolSchema,
  resolveSafePath,
  writeAtomic,
} from '../src/tools/index.js';

describe('Security & Path Traversal Prevention (resolveSafePath)', () => {
  const projectRoot = path.resolve('/tmp/playforge-test-root');

  it('allows safe files and subdirectories within project root', () => {
    const p1 = resolveSafePath(projectRoot, 'src/main.js');
    expect(p1).toBe(path.join(projectRoot, 'src/main.js'));

    const p2 = resolveSafePath(projectRoot, './index.html');
    expect(p2).toBe(path.join(projectRoot, 'index.html'));

    const p3 = resolveSafePath(projectRoot, 'assets/textures/player.png');
    expect(p3).toBe(path.join(projectRoot, 'assets/textures/player.png'));
  });

  it('strictly rejects sibling directory prefix-overlap attacks (CWE-22)', () => {
    // If projectRoot is /tmp/playforge-test-root, attacker tries ../playforge-test-root-sibling
    const siblingPath = '../playforge-test-root-sibling/malicious.js';
    expect(() => resolveSafePath(projectRoot, siblingPath)).toThrow(
      /Security Violation: Path traversal outside project root is forbidden/,
    );
  });

  it('rejects standard directory traversal attempts (../)', () => {
    expect(() => resolveSafePath(projectRoot, '../secret.env')).toThrow(/Security Violation/);
    expect(() => resolveSafePath(projectRoot, '../../../../etc/passwd')).toThrow(
      /Security Violation/,
    );
    expect(() => resolveSafePath(projectRoot, 'src/../../outside.txt')).toThrow(
      /Security Violation/,
    );
  });

  it('rejects null-byte injection attacks', () => {
    expect(() => resolveSafePath(projectRoot, 'src/main.js\0.png')).toThrow(/Security Violation/);
    expect(() => resolveSafePath(projectRoot, '\0/etc/passwd')).toThrow(/Security Violation/);
    expect(() => resolveSafePath(projectRoot, 'safe.txt\0')).toThrow(/Security Violation/);
  });
});

describe('Atomic Writes (writeAtomic)', () => {
  it('writes content atomically to the destination file', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-test-'));
    try {
      const targetFile = path.join(tmpDir, 'sub', 'output.txt');
      const testContent = 'Hello, Playforge atomic write!';

      await writeAtomic(targetFile, testContent);

      const exists = fs.existsSync(targetFile);
      expect(exists).toBe(true);

      const readBack = await fs.promises.readFile(targetFile, 'utf8');
      expect(readBack).toBe(testContent);

      // Verify overwrite
      const updatedContent = 'Updated content here.';
      await writeAtomic(targetFile, updatedContent);
      const readBack2 = await fs.promises.readFile(targetFile, 'utf8');
      expect(readBack2).toBe(updatedContent);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Forward-Compatible Zod Schemas (.passthrough())', () => {
  it('allows unknown properties in TextEditorToolSchema without validation error', () => {
    const parsed = TextEditorToolSchema.parse({
      command: 'str_replace',
      path: 'src/main.js',
      old_str: 'foo',
      new_str: 'bar',
      extra_future_field: 12345,
      another_unknown_flag: true,
    });

    expect(parsed.command).toBe('str_replace');
    expect((parsed as any).extra_future_field).toBe(12345);
    expect((parsed as any).another_unknown_flag).toBe(true);
  });

  it('allows unknown properties in SetTodosToolSchema', () => {
    const parsed = SetTodosToolSchema.parse({
      todos: [
        {
          content: 'Setup physics engine',
          status: 'in_progress',
          priority: 'urgent',
          metadata: { estimatedMs: 5000 },
        },
      ],
      customBatchId: 'batch-99',
    });

    expect(parsed.todos).toHaveLength(1);
    expect((parsed.todos[0] as any).priority).toBe('urgent');
    expect((parsed as any).customBatchId).toBe('batch-99');
  });

  it('allows unknown properties in DoneToolSchema', () => {
    const parsed = DoneToolSchema.parse({
      status: 'completed',
      summary: 'All tasks passed',
      durationMs: 12000,
    });

    expect(parsed.status).toBe('completed');
    expect((parsed as any).durationMs).toBe(12000);
  });

  it('creates passthrough schema with createToolSchema helper', () => {
    const schema = createToolSchema({
      action: DoneToolSchema.shape.status,
    });

    const parsed = schema.parse({
      action: 'completed',
      unknownOption: 'accepted',
    });

    expect(parsed.action).toBe('completed');
    expect((parsed as any).unknownOption).toBe('accepted');
  });
});

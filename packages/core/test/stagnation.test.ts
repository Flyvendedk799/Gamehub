import { describe, expect, it } from 'vitest';
import {
  StagnationDetector,
  formatErrorRecoveryDirective,
  hashSignatureValue,
  suggestRemediation,
} from '../src/agent.js';

describe('StagnationDetector & Error Recovery Directives', () => {
  it('detects stagnation strictly on consecutive identical tool invocations (3-strike threshold)', () => {
    const detector = new StagnationDetector(3);

    const sig = {
      toolName: 'str_replace_based_edit_tool',
      argsHash: hashSignatureValue({ path: 'src/main.js', old_str: 'foo', new_str: 'bar' }),
      outputHash: hashSignatureValue('Target string not found in file'),
    };

    // Strike 1
    const res1 = detector.recordAndCheck(sig);
    expect(res1.isStagnant).toBe(false);
    expect(res1.strikeCount).toBe(1);

    // Strike 2
    const res2 = detector.recordAndCheck(sig);
    expect(res2.isStagnant).toBe(false);
    expect(res2.strikeCount).toBe(2);

    // Strike 3: threshold reached
    const res3 = detector.recordAndCheck(sig);
    expect(res3.isStagnant).toBe(true);
    expect(res3.strikeCount).toBe(3);
  });

  it('resets streak to 1 on intervening distinct tool call or divergent args/output', () => {
    const detector = new StagnationDetector(3);

    const sig1 = {
      toolName: 'str_replace_based_edit_tool',
      argsHash: hashSignatureValue({ path: 'src/main.js', command: 'view' }),
      outputHash: hashSignatureValue('File content'),
    };

    const sig2 = {
      toolName: 'text_editor',
      argsHash: hashSignatureValue({ path: 'src/main.js', command: 'create' }),
      outputHash: hashSignatureValue('File written'),
    };

    // First call sig1
    detector.recordAndCheck(sig1);
    const r2 = detector.recordAndCheck(sig1);
    expect(r2.strikeCount).toBe(2);

    // Intervening call sig2
    const r3 = detector.recordAndCheck(sig2);
    expect(r3.isStagnant).toBe(false);
    expect(r3.strikeCount).toBe(1);

    // Resumed call sig1 starts fresh at streak 1
    const r4 = detector.recordAndCheck(sig1);
    expect(r4.isStagnant).toBe(false);
    expect(r4.strikeCount).toBe(1);
  });

  it('resets completely when reset() is explicitly called', () => {
    const detector = new StagnationDetector(3);
    const sig = {
      toolName: 'validate_game_scene',
      argsHash: 'hash_a',
      outputHash: 'hash_b',
    };

    detector.recordAndCheck(sig);
    detector.recordAndCheck(sig);
    detector.reset();

    const res = detector.recordAndCheck(sig);
    expect(res.strikeCount).toBe(1);
    expect(res.isStagnant).toBe(false);
  });

  it('formats structured error recovery directive with toolName, errorMsg, and remediation', () => {
    const directive = formatErrorRecoveryDirective(
      'str_replace_based_edit_tool',
      'Target string not found',
      'View the file first to check exact indentation.',
    );

    expect(directive).toContain('[Error Recovery Directive: Tool str_replace_based_edit_tool');
    expect(directive).toContain('Target string not found');
    expect(directive).toContain('Do not repeat identical parameters.');
    expect(directive).toContain(
      'Suggested remediation: View the file first to check exact indentation.',
    );
  });

  it('suggests domain-specific remediation based on error and tool type', () => {
    const remediationNotFound = suggestRemediation(
      'str_replace_based_edit_tool',
      'not found in file',
    );
    expect(remediationNotFound).toMatch(/view.*exact current lines/i);

    const remediationValidate = suggestRemediation(
      'validate_game_scene',
      'SyntaxError: Unexpected token',
    );
    expect(remediationValidate).toMatch(/compiler\/runtime errors/i);

    const remediationGeneral = suggestRemediation('unknown_tool', 'General timeout');
    expect(remediationGeneral.length).toBeGreaterThan(0);
  });
});

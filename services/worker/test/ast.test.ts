import { describe, expect, it } from 'vitest';
import {
  formatReflexionPayload,
  verifyGeneratedAst,
} from '../src/verify/ast.js';
import { RedisTelemetryBridge } from '../src/telemetry.js';

describe('AST Syntax Verification (verifyGeneratedAst)', () => {
  it('validates correct JavaScript, TypeScript, and JSX code', async () => {
    const jsCode = `
      import Phaser from 'phaser';
      export class MainScene extends Phaser.Scene {
        preload() {
          this.load.image('ship', 'assets/ship.png');
        }
        create() {
          const sprite = this.add.sprite(100, 100, 'ship');
        }
      }
    `;
    const jsResult = await verifyGeneratedAst('src/main.js', jsCode);
    expect(jsResult.valid).toBe(true);
    expect(jsResult.errors).toHaveLength(0);

    const tsxCode = `
      interface Props {
        score: number;
      }
      export const ScoreBoard: React.FC<Props> = ({ score }) => {
        return <div className="score-board">Score: {score}</div>;
      };
    `;
    const tsxResult = await verifyGeneratedAst('src/ui.tsx', tsxCode);
    expect(tsxResult.valid).toBe(true);
    expect(tsxResult.errors).toHaveLength(0);
  });

  it('detects syntax errors in malformed code and returns line/column positions', async () => {
    const brokenCode = `
      const x = 10;
      const y = ;
      function run() {
    `;
    const result = await verifyGeneratedAst('src/main.js', brokenCode);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    const firstErr = result.errors[0];
    expect(firstErr?.line).toBe(3);
    expect(firstErr?.column).toBeDefined();
    expect(firstErr?.message).toBeTruthy();
  });

  it('extracts and verifies inline JavaScript inside HTML files with correct line offsets', async () => {
    const htmlWithValidJs = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>My Game</title>
        </head>
        <body>
          <script>
            const config = { width: 800, height: 600 };
            console.log("Game started", config);
          </script>
        </body>
      </html>
    `;
    const resValid = await verifyGeneratedAst('index.html', htmlWithValidJs);
    expect(resValid.valid).toBe(true);

    const htmlWithBrokenJs = `<!DOCTYPE html>
<html>
  <head></head>
  <body>
    <!-- line 5 -->
    <script>
      const a = 1;
      const b = ;
    </script>
  </body>
</html>`;
    const resBroken = await verifyGeneratedAst('index.html', htmlWithBrokenJs);
    expect(resBroken.valid).toBe(false);
    expect(resBroken.errors.length).toBeGreaterThan(0);
    // Line in script should match line in HTML (line 8 is "const b = ;")
    expect(resBroken.errors[0]?.line).toBe(8);
  });

  it('ignores external script tags and JSON script tags in HTML', async () => {
    const htmlWithIgnoredScripts = `
      <html>
        <head>
          <script src="https://cdn.jsdelivr.net/npm/phaser@3.80.0/dist/phaser.min.js"></script>
          <script type="application/json">
            { "broken": json without quotes }
          </script>
        </head>
        <body>
          <script>
            const ok = true;
          </script>
        </body>
      </html>
    `;
    const res = await verifyGeneratedAst('index.html', htmlWithIgnoredScripts);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });
});

describe('Diagnostic Reflexion Payload Formatting (formatReflexionPayload)', () => {
  it('returns a pass message when there are no errors', () => {
    const payload = formatReflexionPayload('src/game.ts', 'const a = 1;', []);
    expect(payload).toContain('AST verification passed');
    expect(payload).toContain('src/game.ts');
  });

  it('formats structured error blocks with line numbers and snippet pointers', () => {
    const code = [
      'const a = 1;',
      'const b = 2;',
      'const c = ;',
      'console.log(a + b);',
    ].join('\n');

    const errors = [
      {
        message: 'Unexpected token',
        line: 3,
        column: 10,
      },
    ];

    const payload = formatReflexionPayload('src/index.js', code, errors);
    expect(payload).toContain('[SYNTAX_VERIFICATION_FAILURE] in file: src/index.js');
    expect(payload).toContain('Encountered 1 syntax error(s)');
    expect(payload).toContain('Error 1: Unexpected token (Line 3, Column 10)');
    expect(payload).toContain('>    3 | const c = ;');
    expect(payload).toContain('^ Unexpected token');
    expect(payload).toContain('Action Required: Modify the code to resolve the syntax error(s)');
  });
});

describe('RedisTelemetryBridge Interface', () => {
  it('instantiates and provides clean interface methods', async () => {
    const bridge = new RedisTelemetryBridge('redis://127.0.0.1:6379');
    expect(typeof bridge.publishRunTelemetry).toBe('function');
    expect(typeof bridge.publishGlobalTelemetry).toBe('function');
    expect(typeof bridge.subscribe).toBe('function');
    expect(typeof bridge.close).toBe('function');
    await bridge.close();
  });
});

import { describe, expect, it } from 'vitest';
import {
  describeUnresolvedImport,
  exportedNames,
  findUnresolvedImports,
} from './unresolved-imports';

describe('exportedNames', () => {
  it('reads declarations, lists, aliases and default', () => {
    const names = exportedNames(
      'export const A = 1; export function b() {} export class C {}\nexport { d, e as f }\nexport default 3;',
    );
    expect([...(names ?? [])].sort()).toEqual(['A', 'C', 'b', 'd', 'default', 'f']);
  });

  it('gives up (null) on export-star, rather than guessing', () => {
    expect(exportedNames("export * from './x.js'")).toBeNull();
  });
});

describe('findUnresolvedImports', () => {
  const core = "import { FOG, GROUND, SKY } from '../theme.js';\nexport const x = 1;";

  it('names the importer, the target and every missing export (the live FOG/GROUND bug)', () => {
    const problems = findUnresolvedImports([
      { path: 'src/engine/core.js', content: core },
      { path: 'src/theme.js', content: 'export const THEME = {}; export const SKY = 1;' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      from: 'src/engine/core.js',
      target: 'src/theme.js',
      missing: ['FOG', 'GROUND'],
    });
    const text = describeUnresolvedImport(problems[0] as never);
    expect(text).toContain('src/engine/core.js');
    expect(text).toContain('src/theme.js');
    expect(text).toContain('FOG, GROUND');
  });

  it('is silent when everything resolves, including aliases and namespace imports', () => {
    expect(
      findUnresolvedImports([
        {
          path: 'src/main.js',
          content: "import { a as b } from './m.js'; import * as ns from './m.js';",
        },
        { path: 'src/m.js', content: 'export const a = 1;' },
      ]),
    ).toEqual([]);
  });

  it('flags a missing default export and ignores bare/external specifiers', () => {
    const problems = findUnresolvedImports([
      {
        path: 'src/main.js',
        content:
          "import Thing from './m.js';\nimport * as THREE from 'three';\nimport x from 'lib';",
      },
      { path: 'src/m.js', content: 'export const a = 1;' },
    ]);
    expect(problems.map((p) => p.missing)).toEqual([['default']]);
  });

  it('skips targets it cannot reason about (export *) and files outside the project', () => {
    expect(
      findUnresolvedImports([
        {
          path: 'src/main.js',
          content: "import { z } from './re.js'; import { q } from './gone.js';",
        },
        { path: 'src/re.js', content: "export * from './other.js';" },
      ]),
    ).toEqual([]);
  });

  it('ignores imports that only appear inside comments', () => {
    expect(
      findUnresolvedImports([
        { path: 'src/main.js', content: "// import { nope } from './m.js'\nexport const k = 1;" },
        { path: 'src/m.js', content: 'export const a = 1;' },
      ]),
    ).toEqual([]);
  });
});

/**
 * Feedback for an edit intent whose asserted field the game never exposes.
 *
 * Run dec54cc9 ("My character is facing wrong way"): the agent declared an intent asserting that
 * `playerYaw` changes. Nothing in the game defined `playerYaw`, so the gate read "field 'playerYaw'
 * is missing at step 0" and failed the run with a message that said the EDIT had no effect. The
 * agent then spent its whole budget re-reading files for a rotation bug and never added the field.
 *
 * Two small fixes: say so at declaration time (the name is not even in the source), and when the
 * gate fails for exactly this reason, say that the ASSERTION is unreadable rather than that the
 * edit did nothing.
 */

export interface SourceFile {
  path: string;
  content: string;
}

const SOURCE_PATH = /\.(?:[cm]?[jt]sx?|html?)$/i;

/** `playerPos.y` / `enemies[0].hp` → `playerPos` / `enemies`. */
export function rootOfFieldPath(field: string): string {
  return field.split(/[.[]/)[0]?.trim() ?? '';
}

/**
 * Asserted fields whose root name does not appear in any source file at all. Conservative: a
 * field built from a dynamic key still reads as present only if its root is written somewhere, so
 * a hit here means the game cannot be exposing it.
 */
export function fieldsAbsentFromSource(
  fields: readonly string[],
  files: readonly SourceFile[],
): string[] {
  const sources = files.filter((f) => SOURCE_PATH.test(f.path));
  const absent: string[] = [];
  for (const field of fields) {
    const root = rootOfFieldPath(field);
    if (root.length === 0 || !/^[A-Za-z_$][\w$]*$/.test(root)) continue;
    const re = new RegExp(
      String.raw`(?<![\w$])` + root.replace(/\$/g, String.raw`\$`) + String.raw`(?![\w$])`,
    );
    if (!sources.some((f) => re.test(f.content))) absent.push(field);
  }
  return absent;
}

/** Appended to the declare_edit_intent result when asserted fields are not in the source. */
export function absentFieldWarning(absent: readonly string[]): string {
  if (absent.length === 0) return '';
  const list = absent.map((f) => `\`${f}\``).join(', ');
  return ` WARNING: ${list} ${absent.length === 1 ? 'does' : 'do'} not appear anywhere in the project's source, so the game cannot be exposing ${absent.length === 1 ? 'it' : 'them'} and the check would fail before measuring anything. Part of this edit MUST be exposing ${absent.length === 1 ? 'it' : 'them'} (e.g. window.__game.debug.track({ ${rootOfFieldPath(absent[0] ?? 'value')}: () => <the live value> })) — or re-declare the intent on a field the snapshot already has.`;
}

/**
 * The gate's failure text when assertions could not be READ (the field resolved to nothing) as
 * opposed to read and found wrong. Returns null when every failure is a real measurement.
 */
export function unreadableAssertionNote(
  results: ReadonlyArray<{ pass: boolean; fieldPresent: boolean; predicate: { field: string } }>,
): string | null {
  const unreadable = [
    ...new Set(results.filter((r) => !r.pass && !r.fieldPresent).map((r) => r.predicate.field)),
  ];
  if (unreadable.length === 0) return null;
  const list = unreadable.map((f) => `\`${f}\``).join(', ');
  return `NOTE: ${list} could not be read from window.__game.debug.snapshot() — the game does not expose ${unreadable.length === 1 ? 'it' : 'them'}, so this says nothing about whether the edit worked. Expose ${unreadable.length === 1 ? 'it' : 'them'} (window.__game.debug.track({ ${rootOfFieldPath(unreadable[0] ?? 'value')}: () => <live value> })) and make the actual change, or re-declare edit intent on a field the snapshot already has. Do NOT keep re-reading files: the missing field is the whole problem.`;
}

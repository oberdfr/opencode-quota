/**
 * Styled text helpers for the terminal half.
 *
 * Kept out of `format.ts` so the server half, which imports the pure formatting
 * helpers, never loads `@opentui/core`. The library registers process-global
 * environment variables on import; loading a second copy beside the one OpenCode
 * embeds makes that registration throw and takes the whole plugin down before
 * setup can run.
 */

import { bold, StyledText } from "@opentui/core";

/**
 * Bold text for use as a `text` child.
 *
 * `TextNodeRenderable.add` accepts a string, another renderable, or a
 * `StyledText`, and throws on anything else. The `bold` helper on its own returns
 * a bare chunk, which is none of those, so the chunk is wrapped in a
 * `StyledText`: the styled value the renderable actually expects.
 *
 * The return type is widened only so the published child type accepts it. The
 * value really is a `StyledText` at runtime, which `isStyledText` confirms.
 */
export function strong(value: string): string {
  return new StyledText([bold(value)]) as unknown as string;
}

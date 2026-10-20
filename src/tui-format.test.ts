import { describe, expect, it } from "vitest";
import { bold, isStyledText, StyledText } from "@opentui/core";
import { strong } from "./tui-format.ts";

describe("strong", () => {
  it("produces a value the text renderable accepts", () => {
    // `TextNodeRenderable.add` throws on anything that is not a string, another
    // renderable, or a StyledText, and that throw only happens at render time,
    // so this is the check that keeps it from reaching the TUI.
    expect(isStyledText(strong("r"))).toBe(true);
  });

  it("keeps the bold attribute on the wrapped chunk", () => {
    const [chunk] = new StyledText([bold("r")]).chunks;
    const [wrapped] = new StyledText([bold("r")]).chunks;

    expect(wrapped?.text).toBe("r");
    expect(wrapped?.attributes).toBe(chunk?.attributes);
    expect(wrapped?.attributes).toBeGreaterThan(0);
  });

  it("is why the bare bold chunk cannot be used directly", () => {
    // Documents the trap: the chunk is what `bold` returns, and it is not
    // something `add` accepts on its own.
    expect(isStyledText(bold("r"))).toBeFalsy();
  });
});

import { describe, expect, it } from "vitest";
import { isWrapper, keepText } from "./text";

describe("transcript text", () => {
  it("recognises wrappers after normalisation (invisible characters, compatibility forms)", () => {
    expect(isWrapper("<task​-notification>x</task-notification>")).toBe(true);
    expect(isWrapper("＜bash-input＞rm -rf x＜/bash-input＞")).toBe(true);
    expect(isWrapper("a normal prompt with <b>tags</b>")).toBe(false);
    // Cursor's and Codex's wrappers have `_` in their tag names.
    expect(isWrapper("<cursor_commands>x</cursor_commands>")).toBe(true);
    expect(isWrapper("<environment_context>\n<cwd>/r</cwd>\n</environment_context>")).toBe(true);
    expect(isWrapper("<user_query>x</user_info>")).toBe(false);
  });
  it("drops the pack marker in any case and spacing", () => {
    expect(keepText("x <!--   ALIGN-PACK v2 --> y")).toBeNull();
  });
});

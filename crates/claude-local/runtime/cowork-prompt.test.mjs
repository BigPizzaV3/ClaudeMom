import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCoworkSystemPrompt } from "./official-assets.mjs";

test("loadCoworkSystemPrompt extracts the cowork prompt from app.asar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-local-app-"));
  try {
    fs.writeFileSync(path.join(dir, "app.asar"), [
      ' '.repeat(1024 * 1024 - 24),
      'var t = `<application_details>\\nClaude is operating as an agent inside the Claude desktop app.\\nUse \\`file tools\\`.\\nLiteral: \\\\n and \\${text}. \\u2192 \\u{1F600}\\n</application_details>`;',
      "module.exports = t;",
    ].join("\n"));
    assert.equal(
      loadCoworkSystemPrompt(dir),
      [
        "<application_details>",
        "Claude is operating as an agent inside the Claude desktop app.",
        "Use `file tools`.",
        "Literal: \\n and ${text}. → 😀",
        "</application_details>",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCoworkSystemPrompt returns an empty string when the prompt is unavailable", () => {
  assert.equal(loadCoworkSystemPrompt(""), "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-local-app-"));
  try {
    assert.equal(loadCoworkSystemPrompt(dir), "");
    fs.writeFileSync(path.join(dir, "app.asar"), "no prompt here");
    assert.equal(loadCoworkSystemPrompt(dir), "");
    const prefix = '`<application_details>\\nClaude is operating as an agent inside the Claude desktop app.';
    for (const tail of ["unfinished", "${dynamic}`", "x".repeat(256 * 1024) + "`"]) {
      fs.writeFileSync(path.join(dir, "app.asar"), prefix + tail);
      assert.equal(loadCoworkSystemPrompt(dir), "");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

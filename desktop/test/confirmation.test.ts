import assert from "node:assert/strict";
import test from "node:test";
import { confirmationValue } from "../src/main/confirmation";

test("native confirmation exposes whitespace and directional controls without changing arguments", () => {
  const args = [
    " leading and trailing ",
    "line\nnext\tcolumn",
    "name\u202eevil",
    "\u2066left\u2069",
  ];
  const visible = confirmationValue(args);
  assert.doesNotMatch(visible, /[\u202a-\u202e\u2066-\u2069]/);
  assert.match(visible, /\\u202e/);
  assert.match(visible, /\\n/);
  assert.deepEqual(JSON.parse(visible), args);
  assert.equal(
    confirmationValue("C:\\project\\folder"),
    '"C:\\\\project\\\\folder"',
  );
});

/** Deterministic regression coverage for stale async slice/export responses. */

import { createSliceGeneration } from "../lib/sliceGeneration";

let fails = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) fails++;
};

(async () => {
  const gate = createSliceGeneration();

  const staleAfterEdit = gate.startRequest();
  const lateResponse = Promise.resolve("old slice");
  gate.invalidate();
  check("an edit invalidates an in-flight slice", !gate.isCurrent(staleAfterEdit));
  const response = await lateResponse;
  let applied: string | null = null;
  if (gate.isCurrent(staleAfterEdit)) applied = response;
  check("a late slice response is not applied after await", applied === null);

  const olderRequest = gate.startRequest();
  const newerRequest = gate.startRequest();
  check("a newer request supersedes an older response", !gate.isCurrent(olderRequest));
  check("the newest response remains current", gate.isCurrent(newerRequest));

  const exportSnapshot = gate.capture();
  gate.invalidate();
  check("an edit invalidates an in-flight export snapshot", !gate.isCurrent(exportSnapshot));

  console.log(fails === 0 ? "\nHOTOVO — vše prošlo" : `\n${fails} NESHOD`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});

import assert from "node:assert/strict";
import { createMeshCutGeneration } from "../lib/meshCutGeneration";

const gate=createMeshCutGeneration();
const first=gate.next(7);assert.equal(gate.isCurrent(first),true);
const second=gate.next(7);assert.equal(gate.isCurrent(first),false);assert.equal(gate.isCurrent(second),true);
gate.invalidate(7);assert.equal(gate.isCurrent(second),false);
const other=gate.next(8);gate.clear();assert.equal(gate.isCurrent(other),false);
console.log("[OK] planar cut responses are revision-gated");

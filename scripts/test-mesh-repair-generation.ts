import assert from "node:assert/strict";
import { createMeshRepairGeneration } from "../lib/meshRepairGeneration";

const gate = createMeshRepairGeneration();
const first = gate.next(7);
assert.equal(first.modelId, 7);
assert.equal(gate.isCurrent(first), true);

const second = gate.next(7);
assert.ok(second.revision > first.revision);
assert.equal(gate.isCurrent(first), false, "new analysis supersedes old response for same model");
assert.equal(gate.isCurrent(second), true);

const other = gate.next(8);
assert.equal(gate.isCurrent(second), true, "other model revision does not invalidate selected model");
assert.equal(gate.isCurrent(other), true);

gate.invalidate(7);
assert.equal(gate.isCurrent(second), false);
assert.equal(gate.isCurrent(other), true);

const third = gate.next(7);
gate.remove(7);
assert.equal(gate.isCurrent(third), false, "deleted model rejects late worker response");

gate.clear();
assert.equal(gate.isCurrent(other), false);

console.log("[OK] mesh repair worker responses are revision-gated");

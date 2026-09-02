import assert from "node:assert/strict";
import { isMeshCutResponseApplicable } from "../lib/meshCutApplicability";

const pendingModel={mesh:{positions:new Float32Array([0])},transform:{x:0}};
assert.equal(isMeshCutResponseApplicable(pendingModel,pendingModel),true);
assert.equal(isMeshCutResponseApplicable(undefined,pendingModel),false,"deleted models reject stale cut responses");
assert.equal(isMeshCutResponseApplicable({...pendingModel},pendingModel),false,"edited model revisions reject stale cut responses");
console.log("[OK] planar cut response requires the exact pending mesh revision");

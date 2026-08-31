# Mesh Repair v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic off-main-thread mesh diagnostics, navigable red 3D findings, and an explicit shape-safe repair action for selected STL/OBJ models.

**Architecture:** Extract reusable welded topology from `meshSplit.ts`, then layer pure analysis and repair functions over it. Run analysis in a dedicated Worker with revision gating; keep React responsible only for state/orchestration and Three.js responsible only for disposable overlay geometry.

**Tech Stack:** TypeScript, React 19, Next.js 16, Three.js/react-three-fiber, Web Workers, Node `assert` test scripts.

**Spec:** `docs/superpowers/specs/2026-09-01-mesh-repair-v1-design.md`

## Global Constraints

- No new runtime dependency.
- Never mutate input `StlMesh.positions`, normals, bounds, or transforms.
- Welding uses neighboring spatial cells plus Euclidean distance with default tolerance `1e-5 mm`.
- Analysis runs in a Worker in production; stale responses are ignored by model ID and revision.
- Safe repair never fills holes, deletes tiny shells, or reconstructs non-manifold topology.
- Every geometry mutation uses the existing central slice/export invalidation path.
- All Czech source remains UTF-8; PowerShell reads/writes must specify `-Encoding UTF8`.

---

### Task 1: Shared deterministic mesh topology

**Files:**
- Create: `lib/meshTopology.ts`
- Modify: `lib/meshSplit.ts`
- Create: `scripts/test-mesh-topology.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildMeshTopology(mesh: StlMesh, options?: MeshTopologyOptions): MeshTopology`
- Produces: `MeshTopology` with `weldedVertexByOccurrence`, sorted `edges`, `triangleNeighbors`, and stable `shells`.
- Consumed by: `splitConnectedShells`, analysis, repair planning.

- [ ] **Step 1: Write the failing topology test**

Create fixtures proving exact shared edges, the `0.49t/0.51t` tolerance boundary, point-only contact, boundary edge use-count `1`, manifold use-count `2`, non-manifold use-count `3`, and deterministic shell order:

```ts
const topology = buildMeshTopology(meshFromTriangles([...tetraA, ...tetraB]));
assert.deepEqual(topology.shells, [[0, 1, 2, 3], [4, 5, 6, 7]]);
assert.equal(topology.edges.filter((edge) => edge.uses.length === 1).length, 0);
assert.deepEqual(buildMeshTopology(input), topology);
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npx tsx scripts/test-mesh-topology.ts`  
Expected: module/export missing; after a minimal stub, assertions fail because topology is empty.

- [ ] **Step 3: Implement topology construction**

Define stable public types:

```ts
export interface MeshTopologyOptions { weldToleranceMm?: number }
export interface DirectedEdgeUse {
  triangleIndex: number;
  startVertex: number;
  endVertex: number;
}
export interface TopologyEdge {
  vertices: [number, number];
  uses: DirectedEdgeUse[];
}
export interface MeshTopology {
  weldedVertexByOccurrence: Int32Array;
  representativePositions: Float32Array;
  edges: TopologyEdge[];
  triangleNeighbors: number[][];
  shells: number[][];
}
export function buildMeshTopology(mesh: StlMesh, options?: MeshTopologyOptions): MeshTopology;
```

Deduplicate exact coordinates first, weld unique representatives through 27 neighboring spatial cells with a squared-distance check, sort edges by first triangle then vertex IDs, and derive adjacency only from shared edges.

- [ ] **Step 4: Make topology tests GREEN**

Run: `npx tsx scripts/test-mesh-topology.ts`  
Expected: `[OK] mesh topology is deterministic and tolerance-safe`.

- [ ] **Step 5: Migrate connected-shell split to shared topology**

Replace the private welding/union-find block in `meshSplit.ts` with:

```ts
const topology = buildMeshTopology(mesh, { weldToleranceMm });
return topology.shells.map((triangleIndices) => ({
  triangleIndices,
  mesh: extractMeshTriangles(mesh, triangleIndices),
}));
```

- [ ] **Step 6: Run both topology and existing split regressions**

Run: `npx tsx scripts/test-mesh-topology.ts && npx tsx scripts/test-mesh-split.ts`  
Expected: both PASS; Benchy still yields components `[225705, 1]`.

- [ ] **Step 7: Commit Task 1**

```powershell
git add lib/meshTopology.ts lib/meshSplit.ts scripts/test-mesh-topology.ts package.json
git commit -m "refactor: share deterministic mesh topology"
```

### Task 2: Pure mesh diagnostics

**Files:**
- Create: `lib/meshRepair.ts`
- Create: `scripts/test-mesh-repair-analysis.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildMeshTopology`.
- Produces: `analyzeMesh(mesh, options?): MeshRepairReport`.
- Produces report categories usable by the worker, UI, overlay, and repair planner.

- [ ] **Step 1: Write failing diagnostic fixtures**

Assert each defect independently and confirm the original arrays remain byte-identical:

```ts
const report = analyzeMesh(openTetra);
assert.equal(report.boundaryEdges.count, 3);
assert.equal(report.nonManifoldEdges.count, 0);
assert.deepEqual([...openTetra.positions], before);
```

Cover valid tetrahedron, missing face, three faces on one edge, repeated-vertex and collinear faces, cyclic/reverse duplicates, same-direction shared edges, two shells, and a one-triangle tiny shell.

- [ ] **Step 2: Verify analysis RED**

Run: `npx tsx scripts/test-mesh-repair-analysis.ts`  
Expected: `analyzeMesh` is missing or the first defect count is wrong.

- [ ] **Step 3: Implement report types and deterministic analysis**

```ts
export type MeshIssueKind =
  | "degenerate-triangle" | "duplicate-face" | "boundary-edge"
  | "non-manifold-edge" | "inconsistent-winding" | "tiny-shell";
export interface MeshIssueSample {
  kind: MeshIssueKind;
  triangleIndices: number[];
  edgeVertices?: [number, number];
}
export interface MeshIssueGroup { count: number; samples: MeshIssueSample[] }
export interface MeshRepairReport {
  triangleCount: number;
  shellCount: number;
  degenerateTriangles: MeshIssueGroup;
  duplicateFaces: MeshIssueGroup;
  boundaryEdges: MeshIssueGroup;
  nonManifoldEdges: MeshIssueGroup;
  inconsistentWinding: MeshIssueGroup;
  tinyShells: MeshIssueGroup;
  repairableCount: number;
  unresolvedCount: number;
}
export function analyzeMesh(mesh: StlMesh, options?: {
  weldToleranceMm?: number;
  maxSamplesPerKind?: number;
  tinyShellMaxTriangles?: number;
}): MeshRepairReport;
```

Use scale-aware area epsilon `max(1e-12, diagonal² * 1e-14)`, canonical sorted welded vertex triples for duplicates, edge use counts for topology, directed uses for winding, and stable original-index ordering.

- [ ] **Step 4: Make diagnostic tests GREEN**

Run: `npx tsx scripts/test-mesh-repair-analysis.ts`  
Expected: `[OK] mesh diagnostics classify defects deterministically`.

- [ ] **Step 5: Commit Task 2**

```powershell
git add lib/meshRepair.ts scripts/test-mesh-repair-analysis.ts package.json
git commit -m "feat: analyze mesh topology defects"
```

### Task 3: Dry-run safe repair and one-level restore

**Files:**
- Modify: `lib/meshRepair.ts`
- Create: `scripts/test-mesh-safe-repair.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `planSafeMeshRepair(mesh, report): MeshRepairPlan`.
- Produces: `applySafeMeshRepair(mesh, plan): MeshRepairResult`.
- Result includes `sourceTriangleIndices` for audit/restore mapping.

- [ ] **Step 1: Write failing repair tests**

```ts
const plan = planSafeMeshRepair(broken, analyzeMesh(broken));
assert.deepEqual(plan.removeDegenerateTriangles, [4]);
assert.deepEqual(plan.removeDuplicateTriangles, [5]);
const result = applySafeMeshRepair(broken, plan);
assert.equal(result.mesh.triangleCount, 4);
assert.deepEqual([...broken.positions], before);
```

Also assert vertex coordinates are preserved, lowest duplicate index wins, repair bytes are deterministic, winding becomes consistent, tiny shells remain, non-manifold faces remain, conflicting winding is unresolved, normals/bounds are finite, and an all-degenerate mesh throws a Czech error.

- [ ] **Step 2: Verify repair RED**

Run: `npx tsx scripts/test-mesh-safe-repair.ts`  
Expected: repair planner export missing.

- [ ] **Step 3: Implement dry-run plan and minimal safe transformations**

```ts
export interface MeshRepairPlan {
  removeDegenerateTriangles: number[];
  removeDuplicateTriangles: number[];
  flipTriangles: number[];
  unresolvedWindingComponents: number;
}
export interface MeshRepairResult {
  mesh: StlMesh;
  sourceTriangleIndices: number[];
  removedDegenerate: number;
  removedDuplicates: number;
  flippedTriangles: number;
}
```

Build a parity assignment by BFS across exactly-two-use manifold edges. Flip only components with satisfiable constraints; swap vertices 1 and 2, then recalculate face normals and bounds through `extractMeshTriangles` plus a focused winding helper.

- [ ] **Step 4: Make repair tests GREEN and refactor shared mesh rebuilding**

Run: `npx tsx scripts/test-mesh-safe-repair.ts`  
Expected: `[OK] safe mesh repair preserves intended geometry`.

- [ ] **Step 5: Commit Task 3**

```powershell
git add lib/meshRepair.ts scripts/test-mesh-safe-repair.ts package.json
git commit -m "feat: add deterministic safe mesh repair"
```

### Task 4: Worker analysis and stale-response gate

**Files:**
- Create: `lib/meshRepair.worker.ts`
- Create: `lib/meshRepairGeneration.ts`
- Create: `scripts/test-mesh-repair-generation.ts`
- Modify: `package.json`

**Interfaces:**
- Worker consumes `{ requestId, modelId, revision, mesh }`.
- Worker emits `{ requestId, modelId, revision, ok, report?, error? }`.
- `createMeshRepairGeneration()` tracks per-model revisions and validates responses.

- [ ] **Step 1: Write failing generation-gate tests**

```ts
const gate = createMeshRepairGeneration();
const first = gate.next(7);
const second = gate.next(7);
assert.equal(gate.isCurrent(7, first), false);
assert.equal(gate.isCurrent(7, second), true);
gate.remove(7);
assert.equal(gate.isCurrent(7, second), false);
```

- [ ] **Step 2: Verify generation RED**

Run: `npx tsx scripts/test-mesh-repair-generation.ts`  
Expected: generation factory missing.

- [ ] **Step 3: Implement the gate and worker protocol**

The worker catches errors and returns a Czech-safe string. Do not transfer the live model buffer from React; structured clone the mesh so viewport/slicer arrays cannot detach.

- [ ] **Step 4: Make generation tests GREEN and typecheck worker**

Run: `npx tsx scripts/test-mesh-repair-generation.ts && npm run typecheck`  
Expected: PASS with no TS errors.

- [ ] **Step 5: Commit Task 4**

```powershell
git add lib/meshRepair.worker.ts lib/meshRepairGeneration.ts scripts/test-mesh-repair-generation.ts package.json
git commit -m "feat: analyze meshes in a revision-gated worker"
```

### Task 5: Disposable 3D diagnostic overlay

**Files:**
- Create: `lib/meshRepairOverlay.ts`
- Create: `scripts/test-mesh-repair-overlay.ts`
- Modify: `components/Viewport.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildMeshRepairOverlay(mesh, sample): { triangles: BufferGeometry | null; edges: BufferGeometry | null }`.
- `Viewport` receives `meshDiagnostic?: { modelId: number; sample: MeshIssueSample } | null`.

- [ ] **Step 1: Write failing overlay test**

Assert triangle positions match source coordinates, edge samples create two-point line segments, source arrays are unchanged, invalid indices throw, and geometries can be disposed.

- [ ] **Step 2: Verify overlay RED**

Run: `npx tsx scripts/test-mesh-repair-overlay.ts`  
Expected: overlay builder missing.

- [ ] **Step 3: Implement overlay builder and React component**

Render triangle samples as translucent red `meshBasicMaterial` with `depthTest={false}` and edge samples as red `lineSegments`. Apply the same model transform/geometry offset as the selected model. Dispose both geometries in an effect cleanup and render nothing during slice layer preview.

- [ ] **Step 4: Make overlay and immutability tests GREEN**

Run: `npx tsx scripts/test-mesh-repair-overlay.ts && npx tsx scripts/test-viewport-mesh-immutability.ts`  
Expected: both PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add lib/meshRepairOverlay.ts components/Viewport.tsx scripts/test-mesh-repair-overlay.ts package.json
git commit -m "feat: highlight mesh defects in the viewport"
```

### Task 6: React workflow and Czech Mesh Repair UI

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Create: `scripts/test-mesh-repair-model-state.ts`
- Create: `lib/meshRepairModelState.ts`
- Modify: `package.json`

**Interfaces:**
- Pure helper `applyRepairToModelState(item, result)` produces the repaired model plus a one-level backup.
- Page owns worker lifecycle, report cache, active category/sample, loading/error state, and repair action.

- [ ] **Step 1: Write failing model-state test**

```ts
const next = applyRepairToModelState(item, repairResult);
assert.equal(next.mesh, repairResult.mesh);
assert.equal(next.transform, item.transform);
assert.equal(next.repairBackup?.mesh, item.mesh);
const restored = restoreRepairBackup(next);
assert.equal(restored.mesh, item.mesh);
assert.deepEqual(restored.transform, item.transform);
```

- [ ] **Step 2: Verify state-helper RED**

Run: `npx tsx scripts/test-mesh-repair-model-state.ts`  
Expected: state helper missing.

- [ ] **Step 3: Implement state helper and extend `ModelItem`**

Use a structural generic so the helper does not import `app/page.tsx`:

```ts
export interface RepairableModel<TTransform> {
  mesh: StlMesh;
  transform: TTransform;
  repairBackup?: { mesh: StlMesh; transform: TTransform };
}
```

`restoreRepairBackup` clears the backup after restoration; normal **Vrať** behavior remains unchanged when no repair backup exists.

- [ ] **Step 4: Make model-state test GREEN**

Run: `npx tsx scripts/test-mesh-repair-model-state.ts`  
Expected: PASS.

- [ ] **Step 5: Integrate automatic worker analysis**

Create one worker in an effect, terminate on unmount, request reports whenever a model mesh reference changes, ignore stale revisions, remove cached reports with deleted models, and display `Analyzuji…` without blocking model controls.

- [ ] **Step 6: Add the `Kontrola modelu` section**

Show status `✓ bez zjištěných topologických vad` or category rows with counts. Each row activates the first sample and exposes previous/next navigation. Show dry-run text such as `Odstranit 2 degenerované + 1 duplicitní plochu · otočit 14 ploch`; disable repair when `repairableCount === 0`.

- [ ] **Step 7: Wire manual safe repair**

On click, recompute report/plan against the current mesh, apply repair, store backup, update `modelsRef`, select the repaired model, clear diagnostic selection, request re-analysis, call `invalidateSlice()`, and show a Czech summary toast. Errors leave the model untouched.

- [ ] **Step 8: Pass UI typecheck/build**

Run: `npm run typecheck && npm run build`  
Expected: both succeed; no conditional React hooks.

- [ ] **Step 9: Commit Task 6**

```powershell
git add app/page.tsx app/globals.css lib/meshRepairModelState.ts scripts/test-mesh-repair-model-state.ts package.json
git commit -m "feat: add Mesh Repair report and safe repair workflow"
```

### Task 7: Full verification, review, documentation, and deployment

**Files:**
- Modify: `3D tisk/SLA slicer/02 — Roadmapa.md` (vault)
- Modify: `3D tisk/SLA slicer/08 — Podpory a 3D náhled (2026-08-26).md` (vault)
- Modify: `3D tisk/SLA slicer/09 — Feature parity Chitubox a Lychee (research 2026-08-27).md` (vault)
- Modify: `3D tisk/SLA slicer/10 — P3 Mesh Repair v1 (2026-09-01).md` (vault)

**Interfaces:**
- Produces a reviewed, documented, production-deployed P3 milestone.

- [ ] **Step 1: Run focused performance audit**

Analyze `public/models/3DBenchy.stl`; record triangle count, shell count, issue counts, elapsed worker-equivalent CPU time, and peak-friendly sample caps. Confirm UI analysis is asynchronous.

- [ ] **Step 2: Run complete verification**

```powershell
rtk npm test
rtk npm run test:fullres
rtk npm run build
git diff --check
git status --short
```

Expected: every command passes and only intended files are changed.

- [ ] **Step 3: Request independent code review**

Review topology correctness, repair safety, worker staleness, React hooks, buffer mutation/disposal, performance, Czech encoding, and spec compliance. Reproduce every Important/Critical finding with a failing test before fixing it.

- [ ] **Step 4: Update vault documentation**

Record architecture, red→green evidence, diagnostic semantics, explicit safety boundary, Benchy findings/performance, review fixes, commits, deployment ID, and remaining P3 work. Mark Mesh Repair v1 complete without marking hole filling, planar cut, or booleans complete.

- [ ] **Step 5: Commit and push final changes**

```powershell
git add -A
git commit -m "feat: complete P3 mesh repair v1"
git push origin master
```

- [ ] **Step 6: Deploy and verify production**

```powershell
npx vercel deploy --prod --yes --force --scope deniska25dd-9163
$commit = git rev-parse --short HEAD
npx vercel inspect https://slicer-web-liart.vercel.app --scope deniska25dd-9163
Invoke-WebRequest "https://slicer-web-liart.vercel.app/?verify=$commit" -UseBasicParsing -Headers @{'Cache-Control'='no-cache'}
```

Expected: deployment `Ready`, production alias HTTP 200, `HEAD` equals `origin/master`, and repo status is clean.

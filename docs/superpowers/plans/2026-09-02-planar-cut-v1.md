# Planar Cut v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an exact arbitrary-plane mesh cut with GPU preview, optional watertight cap, keep-one/keep-both output, stale-worker protection, and one-transaction restore.

**Architecture:** A pure `meshCut` module clips triangles in local coordinates and builds planar contours/caps. A revision-gated worker performs commits while `Viewport` renders an immutable two-color clipping preview and plane gizmo; `page.tsx` owns the cut transaction and scene replacement.

**Tech Stack:** TypeScript, Three.js/R3F, Web Workers, Node assertion scripts, Next.js 16.

**Spec:** `docs/superpowers/specs/2026-09-01-planar-cut-v1-design.md`

## Global Constraints

- No voxelization or resampling of untouched source triangles.
- Plane side conventions must be identical in preview, worker, and scene commit.
- Cap defaults on and supports nested inner contours.
- No scene mutation on error, cancellation, or stale response.
- Existing slice/support/raft/export data is invalidated only after a committed cut.
- All text edits remain valid UTF-8; do not rewrite sources through PowerShell 5.1 without explicit UTF-8 handling.

---

### Task 1: Exact half-space clipping core

**Files:**
- Create: `lib/meshCut.ts`
- Create: `scripts/test-mesh-cut.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `cutMeshByPlane(mesh: StlMesh, plane: CutPlane, options?: { cap?: boolean }): MeshCutResult`
- Types: `CutPlane { normal: [number, number, number]; constant: number }`, `MeshCutResult { positive: StlMesh; negative: StlMesh; intersectionSegments: number; capTriangles: number }`

- [ ] Write a failing cube test asserting two non-empty halves, bounds at `x=0.5`, no source mutation, and unchanged coordinates for wholly retained faces.
- [ ] Run `npx tsx scripts/test-mesh-cut.ts`; verify failure because `lib/meshCut.ts` does not exist.
- [ ] Implement signed-distance classification, Sutherland-Hodgman clipping for both half-spaces, deterministic polygon triangulation, finite normal/bounds rebuilding, and no-intersection/empty-side errors.
- [ ] Add vertex/edge/coplanar and oblique-plane cases asserting zero degenerate or duplicate output faces.
- [ ] Run `npx tsx scripts/test-mesh-cut.ts` and `npm run typecheck`; require pass.
- [ ] Add `tsx scripts/test-mesh-cut.ts` to `test:core` and commit `feat: add exact planar mesh clipping`.

### Task 2: Closed contours and cap with holes

**Files:**
- Modify: `lib/meshCut.ts`
- Modify: `scripts/test-mesh-cut.ts`

**Interfaces:**
- Consumes crossing-triangle intersection segments from Task 1.
- Produces positive/negative cap faces with opposite winding and zero boundary edges for valid closed solids.

- [ ] Add failing tests for a centered cube, an oblique cube, a concave prism, a hollow rectangular tube, and two separated cubes; assert `analyzeMesh(output).boundaryEdges.count === 0` with cap enabled.
- [ ] Run the focused test and verify the hollow-tube/concave cases fail before cap support.
- [ ] Weld segment endpoints using spatial buckets plus actual distance, assemble degree-2 loops, project into a plane basis, classify nesting by point containment, and triangulate outer rings with direct holes via `THREE.ShapeUtils.triangulateShape`.
- [ ] Add explicit errors for open/branching contours and cap triangulation failure; cap-disabled output must retain boundary edges intentionally.
- [ ] Re-run focused test and typecheck; require all cases to pass deterministically twice.
- [ ] Commit `feat: cap planar cuts with nested contours`.

### Task 3: Plane conversion and stale worker gate

**Files:**
- Create: `lib/meshCutPlane.ts`
- Create: `lib/meshCutGeneration.ts`
- Create: `lib/meshCut.worker.ts`
- Create: `scripts/test-mesh-cut-plane.ts`
- Create: `scripts/test-mesh-cut-generation.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `worldPlaneToLocal(plane, mesh, transform): CutPlane` and `createMeshCutGeneration()` with `next`, `invalidate`, `clear`, `isCurrent`.
- Worker request carries `{ requestId, modelId, revision, mesh, plane, cap }`; response carries `{ ok, positive?, negative?, stats?, error? }`.

- [ ] Write failing tests for translated, rotated, and scaled model transforms by comparing local signed distances with transformed world points.
- [ ] Implement inverse model-matrix plane conversion using Three.js `Plane.applyMatrix4` and the same viewport placement contract.
- [ ] Write and pass stale/current/invalidated generation tests modeled on Mesh Repair.
- [ ] Implement worker input validation and exact cut invocation; never transfer/mutate the input buffers.
- [ ] Add both scripts to `test:core`, run focused tests and typecheck, then commit `feat: run planar cuts in revision-gated worker`.

### Task 4: Cut transaction state and restore

**Files:**
- Create: `lib/meshCutModelState.ts`
- Create: `scripts/test-mesh-cut-model-state.ts`
- Modify: `app/page.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces `applyCutResultToModels(models, selectedId, result, keepMode, nextIds, transactionId)` and `restoreCutTransaction(models, transactionId)`.
- Generated models carry a compact shared transaction descriptor sufficient to restore one original model and remove both generated siblings.

- [ ] Write failing state tests for positive-only, negative-only, both, stable scene order, preserved transform, independent mesh objects, and restore from either generated half.
- [ ] Implement pure immutable state helpers; generated models clear repair backups and retain exact original/original-transform snapshots only once per transaction.
- [ ] Integrate `Vrať` so a cut transaction restores scene membership before existing repair/reset behavior.
- [ ] Run focused tests and typecheck; commit `feat: add reversible planar cut transactions`.

### Task 5: GPU preview, arbitrary plane controls, and workflow UI

**Files:**
- Modify: `components/Viewport.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Create: `lib/meshCutUiState.ts`
- Create: `scripts/test-mesh-cut-ui-state.ts`
- Modify: `package.json`

**Interfaces:**
- `Viewport` receives `cutPreview?: { modelId, normal, constant }` and `onCutPlaneChange`.
- Page state tracks active model, plane center/normal, keep mode, cap, running status, and current worker token.

- [ ] Write failing pure-state tests for center initialization, X/Y/Z presets, normalized arbitrary rotations, keep-mode defaults, and Escape cancellation.
- [ ] Render the selected model twice with complementary local clipping planes (blue positive, orange negative), a translucent plane/grid helper, and dedicated TransformControls; disable ordinary model gizmo while cut mode is active.
- [ ] Add `Planar Cut` controls: start, X/Y/Z, move/rotate mode, keep selector, cap checkbox, `Rozříznout`, `Zrušit`, progress/error text.
- [ ] Wire worker lifecycle, stale response rejection, scene transaction commit, slice invalidation, diagnostics refresh, and Czech success/error toasts.
- [ ] Run UI-state test, full typecheck, and build; commit `feat: add interactive planar cut workflow`.

### Task 6: Regression, documentation, deployment, and sleep

**Files:**
- Modify: `3D tisk/SLA slicer/02 — Roadmapa.md` (vault)
- Create: `3D tisk/SLA slicer/11 — P3 Planar Cut v1 (2026-09-02).md` (vault)
- Modify: `3D tisk/SLA slicer/09 — Feature parity Chitubox a Lychee (research 2026-08-27).md` (vault)

**Interfaces:**
- No new runtime API; this task proves and records the delivered behavior.

- [ ] Run `npm test`, `npm run test:fullres`, `npm run build`, `git diff --check`, and strict UTF-8 decoding for every changed source.
- [ ] Measure Benchy center and oblique cut duration; analyze both outputs for degenerates, boundaries, non-manifold edges, and winding.
- [ ] Request code review; fix every Critical/Important finding using a failing regression test first.
- [ ] Update vault roadmap/parity and create the Planar Cut implementation note with commits, tests, limitations, and deployment evidence; add an inbound link from the roadmap.
- [ ] Push `master`, deploy production with Vercel, inspect `Ready`, and verify the production alias returns HTTP 200.
- [ ] Schedule Windows sleep only after all previous checks succeed and a final user-facing completion message is ready.

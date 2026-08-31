# Mesh Repair v1 Design

**Date:** 2026-09-01  
**Status:** Approved in chat  
**Scope:** First mesh-analysis and safe-repair milestone of P3

## Goal

Automatically analyze every imported or geometrically changed STL/OBJ model, explain topology defects in Czech, highlight findings in the 3D viewport, and offer an explicit non-destructive **Bezpečně opravit** action for repairs that cannot change the intended shape.

## Product behavior

- Analysis starts automatically after import and after any operation that replaces mesh geometry.
- Analysis runs outside the main UI thread and is cached per model/mesh revision.
- A new **Kontrola modelu** section reports issue counts and overall state.
- Selecting a report category highlights its affected triangles or edges in red in the 3D viewport. Previous/next navigation moves between bounded samples; the report always shows the full count.
- Repair is never automatic. The button first states exact planned counts, then applies them only after the user clicks **Bezpečně opravit**.
- The repair result preserves the model transform. The pre-repair mesh becomes `original`, so the existing **Vrať** action restores the complete pre-repair model.
- Any repair invalidates stale slice, preview, support diagnostics, and export state through the existing central invalidation path.

## Diagnostics

`analyzeMesh(mesh, options)` returns a deterministic `MeshRepairReport` containing:

1. **Degenerate triangles:** repeated welded vertices or triangle area below a scale-aware epsilon.
2. **Duplicate faces:** same three welded vertex IDs regardless of cyclic order or winding.
3. **Boundary/open edges:** undirected welded edge referenced by exactly one retained face.
4. **Non-manifold edges:** undirected welded edge referenced by more than two retained faces.
5. **Inconsistent winding:** a two-face shared edge traversed in the same direction by both faces.
6. **Connected shells:** total shell count plus tiny-shell samples, where a shell is suspicious when it is isolated and below configurable triangle-count and bounding-box thresholds. Tiny shells are reported, never automatically deleted.

Counts must distinguish raw findings from bounded viewport samples. Diagnostics use the same coordinate welding semantics as connected-shell split: neighboring spatial cells plus actual 3D distance, not quantization-key equality.

## Safe repair

`planSafeMeshRepair(mesh, report)` produces a deterministic dry-run plan. `applySafeMeshRepair(mesh, plan)`:

- removes degenerate triangles;
- removes duplicate faces, keeping the lowest original triangle index;
- propagates consistent winding across manifold two-face adjacency components;
- recalculates face normals and bounds;
- returns the repaired mesh, change counts, and a source-triangle mapping.

Safe repair does **not** fill holes, delete tiny shells, resolve non-manifold topology, merge vertices destructively, or guess self-intersection fixes. Those findings remain visible after re-analysis.

If winding constraints conflict inside a component, that component is left unchanged and reported as unresolved. An empty repair result is rejected rather than replacing the model.

## Architecture

### `lib/meshTopology.ts`

Owns deterministic coordinate welding and reusable topology construction: welded vertex IDs, undirected edges, directed edge uses, triangle adjacency, and connected components. `meshSplit.ts` will consume this shared topology instead of maintaining a second welding implementation.

### `lib/meshRepair.ts`

Pure analysis, dry-run planning, and repair application. It does not import React, Three.js, worker APIs, or browser globals.

### `lib/meshRepair.worker.ts`

Receives cloned mesh arrays, runs analysis, and returns serializable reports. Requests include model ID and a monotonically increasing revision; stale responses are ignored.

### `app/page.tsx`

Owns per-model analysis state, revision invalidation, repair confirmation/application, Czech report copy, and selection of the active finding.

### `components/Viewport.tsx`

Receives optional diagnostic overlay data. Triangle findings use a translucent red surface offset; edge findings use red line segments. Overlay buffers are disposed on change/unmount and never mutate source mesh arrays.

## Performance and safety

- All production analysis is worker-based; no full-model topology pass runs synchronously during React render.
- Full counts are retained, but overlay samples are capped to prevent GPU/UI overload.
- Input `StlMesh` arrays are immutable. Analysis and dry-run planning cannot modify them.
- Output order is deterministic by original triangle/edge index.
- No new runtime dependency is introduced in v1.

## Testing

TDD fixtures cover each defect independently and in combination:

- valid closed tetrahedron produces no repairable issue;
- open tetrahedron reports boundary edges;
- three faces sharing an edge report non-manifold topology;
- zero-area/repeated-vertex triangles are removed;
- cyclic and reverse-wound duplicate faces are detected deterministically;
- inconsistent winding is repaired without changing vertex coordinates;
- tiny disconnected shell is reported but preserved;
- tolerance-cell boundary vertices weld correctly;
- analysis and planning do not mutate input arrays;
- repeated runs produce identical reports and repaired bytes;
- viewport overlay construction does not mutate mesh arrays and disposes buffers;
- stale worker reports cannot replace a newer model revision.

Verification requires the targeted tests, `npm test`, `npm run test:fullres`, `npm run build`, `git diff --check`, independent code review, production deployment, and an HTTP check of the Vercel alias.

## Out of scope

- hole filling/capping;
- self-intersection repair;
- destructive non-manifold reconstruction;
- planar cut and boolean operations;
- undo/redo history beyond the current one-level **Vrať** behavior;
- automatic repair during import.


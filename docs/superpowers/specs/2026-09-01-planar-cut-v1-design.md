# Planar Cut v1 — Design

**Date:** 2026-09-01  
**Status:** Approved in chat  
**Milestone:** P3 Model Preparation

## Goal

Add an exact, non-voxel planar cutting workflow for the selected STL/OBJ mesh. The user can position and rotate an arbitrary plane, preview both sides, and commit either side or both as printable capped meshes.

## User-approved behavior

- The plane supports arbitrary translation and rotation, with X/Y/Z presets.
- Commit mode supports keeping the normal side, the opposite side, or both sides.
- Keeping both is the default and creates two independently selectable models.
- Cap is enabled by default; an explicit option permits an uncapped cut.
- Connector pins, sockets, clearances, and alignment keys are out of scope for v1.
- The cut must never voxelize or resample the untouched source surface.

## UI and interaction

Planar Cut lives in the selected-model preparation controls.

1. **Enter cut mode:** initialize the plane at the selected model's world-space bounding-box center.
2. **Manipulate:** show a plane/grid helper and transform controls. Translation moves the plane along its local normal; rotation is unrestricted. X/Y/Z preset buttons reset the normal while preserving the plane center.
3. **Preview:** render the positive half blue and the negative half orange using GPU clipping. A thin intersection guide communicates the intended cut location; preview does not mutate mesh data.
4. **Options:** `Obě části` (default), `Strana normály`, `Opačná strana`; `Uzavřít řez` enabled by default.
5. **Commit/cancel:** `Rozříznout` starts the worker and disables conflicting model edits; `Zrušit` exits without changing the scene. Escape cancels only when no commit is running.
6. **Result:** one-side mode replaces the selected model. Both-side mode replaces it with the positive result and inserts the negative result next to it in scene order. Both preserve the original world transform.

## Coordinate-space contract

- The interactive plane is expressed in world coordinates because the gizmo and preview live in the scene.
- Before computation, the plane is transformed by the inverse model matrix into mesh-local coordinates using the mathematically correct inverse-transpose normal transform.
- The worker receives an immutable mesh snapshot, the local plane, cap setting, model revision, and request token.
- Output vertices remain in mesh-local coordinates. Both result models reuse the original transform, preventing double transforms, mirroring, or movement on commit.
- Plane normal orientation defines positive and negative output consistently across preview, worker, naming, and keep-side selection.

## Exact cutting algorithm

For each source triangle, compute signed distances to the local plane with a scale-aware epsilon.

- All positive: copy unchanged to the positive result.
- All negative: copy unchanged to the negative result.
- Coplanar: assign deterministically from the source normal and plane normal; do not duplicate a coplanar sheet into both outputs.
- Crossing: clip the triangle polygon independently against both half-spaces, producing one or two non-degenerate triangles per side while preserving source winding.
- Every crossing triangle contributes one exact intersection segment. Endpoints are welded with the shared mesh tolerance, without transitive over-welding.

The untouched triangle coordinates are copied bit-for-bit. Only newly created intersection vertices and cap triangles contain calculated coordinates.

## Contours and cap

- Welded intersection segments are assembled into deterministic closed contours.
- Degree-1 chains, degree-3+ branches, duplicate segments, self-intersections, or unresolved topology abort capped commit with a precise error instead of producing a fake cap.
- All cut contours are planar by construction and project into a stable 2D basis derived from the cutting plane.
- Contours are classified by containment depth. Even-depth contours are outer rings and odd-depth contours are holes.
- Each outer ring and its direct holes are triangulated with a robust polygon-with-holes triangulator.
- Positive and negative cap triangles share coordinates but use opposite winding and normals.
- Empty-side results are rejected. With cap disabled, valid open chains are allowed only as uncapped output and remain diagnosable by Mesh Repair.

## Worker, state, and cancellation

- Heavy geometry runs in a dedicated module worker.
- Requests are revision-gated like Mesh Repair and slicing. A stale response cannot replace a changed, deleted, duplicated, or reselected model.
- Progress states: preparing, splitting triangles, assembling contours, capping, applying.
- Cancel terminates or invalidates the active request without applying partial output.
- The original model is retained as an immutable one-level cut backup. `Vrať` restores the original mesh, transform, and scene membership; both-result mode treats the two generated models as one cut transaction.
- Any committed cut invalidates supports, raft, layer preview, slice/export result, mesh diagnostics, and derived estimates.

## Error handling

The operation fails without scene mutation when:

- the plane does not cross the mesh,
- one requested result is empty,
- source coordinates or plane values are non-finite,
- capped contours are open, branching, duplicated, or self-intersecting,
- triangulation cannot preserve all contour edges,
- the request becomes stale or is cancelled.

Errors use actionable Czech messages and keep cut mode open so the user can adjust the plane or disable cap deliberately.

## Performance boundaries

- Triangle classification and clipping are linear in source triangle count.
- Endpoint welding uses a spatial hash and actual 3D-distance verification.
- Contour assembly is linear in intersection segment count.
- Only cap triangulation is super-linear in contour size; it processes the usually small cross-section, not the full mesh.
- Benchy (225k triangles) is the performance regression model. Preview remains GPU-only and interactive while the exact commit runs off the main thread.

## Tests and acceptance criteria

### Core geometry

- Cube cut through center: two closed halves with expected bounds and volumes.
- Oblique cube cut: exact plane adherence, finite normals, consistent winding, no boundary edges.
- Plane outside mesh: deterministic no-intersection error and no mutation.
- Plane through vertex/edge/coplanar face: no zero-area triangles or duplicate faces.
- Concave cross-section: cap stays inside the contour.
- Hollow tube: cap preserves the inner hole on both outputs.
- Multi-shell model: every intersected shell is capped independently.
- Cap disabled: untouched surface remains exact and cut boundary remains intentionally open.
- Repeating identical input produces byte-identical result ordering.

### State and integration

- World/local plane conversion matches the GPU preview under translation, rotation, and non-unit scale.
- Keep positive, keep negative, and keep both select the correct side without mirroring.
- Stale worker results are ignored.
- Cancel is non-mutating.
- Undo restores the exact original scene transaction.
- Cut invalidates slice preview, supports, raft, diagnostics, and export state.

### Verification

- Focused red-green tests for every contract above.
- Full `npm test`, `npm run test:fullres`, and production `npm run build`.
- Benchy performance measurement and topology report for both outputs.
- Browser interaction check when a browser connection is available; otherwise explicit manual verification remains recorded.

## Out of scope for v1

- Pins, sockets, connector clearances, dovetails, and keyed joints.
- Curved or freehand cuts.
- Boolean union/intersection/subtraction beyond the half-space cut.
- Voxel fallback or automatic repair of arbitrary non-manifold intersections.
- Multi-level global undo/redo; v1 provides one cut-transaction restore compatible with the current model workflow.

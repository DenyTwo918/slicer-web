import type { CutPlane } from "./meshCut";
import { viewportMeshPlacement } from "./previewCoordinates";
import type { ModelTransform } from "./transform";

type Bounds={min:readonly [number,number,number];max:readonly [number,number,number]};
function shift(bounds:Bounds,transform:ModelTransform):[number,number,number]{const p=viewportMeshPlacement(bounds,transform);return[p.geometryX+p.groupX,p.geometryY+p.groupY,transform.z];}
export function localPlaneToWorld(plane:CutPlane,bounds:Bounds,transform:ModelTransform):CutPlane{const s=shift(bounds,transform);return{normal:[...plane.normal],constant:plane.constant-plane.normal[0]*s[0]-plane.normal[1]*s[1]-plane.normal[2]*s[2]};}
export function worldPlaneToLocal(plane:CutPlane,bounds:Bounds,transform:ModelTransform):CutPlane{const s=shift(bounds,transform);return{normal:[...plane.normal],constant:plane.constant+plane.normal[0]*s[0]+plane.normal[1]*s[1]+plane.normal[2]*s[2]};}

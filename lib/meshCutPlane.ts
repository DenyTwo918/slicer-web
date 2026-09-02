import * as THREE from "three";
import type { CutPlane } from "./meshCut";
import { viewportMeshPlacement } from "./previewCoordinates";
import type { ModelTransform } from "./transform";

type Bounds={min:readonly [number,number,number];max:readonly [number,number,number]};
function localToWorldMatrix(bounds:Bounds,transform:ModelTransform):THREE.Matrix4{
  const placement=viewportMeshPlacement(bounds,transform);
  const height=bounds.max[2]-bounds.min[2];
  const position=new THREE.Vector3(placement.groupX,placement.groupY,height/2+transform.z);
  const rotation=new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(transform.rx),
    THREE.MathUtils.degToRad(transform.ry),
    THREE.MathUtils.degToRad(transform.rz),
    "XYZ",
  ));
  const scale=new THREE.Vector3(transform.scale,transform.scale,transform.scale);
  return new THREE.Matrix4().compose(position,rotation,scale).multiply(
    new THREE.Matrix4().makeTranslation(placement.geometryX,placement.geometryY,-height/2),
  );
}

function transformPlane(plane:CutPlane,matrix:THREE.Matrix4):CutPlane{
  const transformed=new THREE.Plane(new THREE.Vector3(...plane.normal),plane.constant).normalize().applyMatrix4(matrix);
  return {normal:transformed.normal.toArray() as [number,number,number],constant:transformed.constant};
}

export function localPlaneToWorld(plane:CutPlane,bounds:Bounds,transform:ModelTransform):CutPlane{
  return transformPlane(plane,localToWorldMatrix(bounds,transform));
}
export function worldPlaneToLocal(plane:CutPlane,bounds:Bounds,transform:ModelTransform):CutPlane{
  return transformPlane(plane,localToWorldMatrix(bounds,transform).invert());
}

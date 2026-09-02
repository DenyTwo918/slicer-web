import assert from "node:assert/strict";
import * as THREE from "three";
import { localPlaneToWorld, worldPlaneToLocal } from "../lib/meshCutPlane";

const bounds={min:[10,20,0] as [number,number,number],max:[30,40,50] as [number,number,number]};
const transform={x:7,y:-3,z:0,rx:0,ry:0,rz:0,scale:1};
const local={normal:[1,0,0] as [number,number,number],constant:-20};
const world=localPlaneToWorld(local,bounds,transform);
assert.deepEqual(world,{normal:[1,0,0],constant:-7});
assert.deepEqual(worldPlaneToLocal(world,bounds,transform),local);

const transformed={x:7,y:-3,z:4,rx:20,ry:-35,rz:15,scale:1.7};
const oblique={normal:[1,2,-0.5] as [number,number,number],constant:-13};
const transformedWorld=localPlaneToWorld(oblique,bounds,transformed);
assert.notDeepEqual(transformedWorld.normal,oblique.normal,"rotation changes the plane normal");
const roundTrip=worldPlaneToLocal(transformedWorld,bounds,transformed);
const normalize=(plane:typeof oblique)=>{
  const length=Math.hypot(...plane.normal);
  return {normal:plane.normal.map((value)=>value/length),constant:plane.constant/length};
};
const expected=normalize(oblique), actual=normalize(roundTrip);
actual.normal.forEach((value,index)=>assert.ok(Math.abs(value-expected.normal[index])<1e-9));
assert.ok(Math.abs(actual.constant-expected.constant)<1e-9);

const localPoint=new THREE.Vector3(13,0,0);
assert.ok(Math.abs(new THREE.Plane(new THREE.Vector3(...oblique.normal),oblique.constant).distanceToPoint(localPoint))<1e-9);
console.log("[OK] planar cut plane conversion matches viewport placement");

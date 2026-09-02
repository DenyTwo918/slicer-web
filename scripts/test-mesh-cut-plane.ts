import assert from "node:assert/strict";
import { localPlaneToWorld, worldPlaneToLocal } from "../lib/meshCutPlane";

const bounds={min:[10,20,0] as [number,number,number],max:[30,40,50] as [number,number,number]};
const transform={x:7,y:-3,z:0,rx:0,ry:0,rz:0,scale:1};
const local={normal:[1,0,0] as [number,number,number],constant:-20};
const world=localPlaneToWorld(local,bounds,transform);
assert.deepEqual(world,{normal:[1,0,0],constant:-7});
assert.deepEqual(worldPlaneToLocal(world,bounds,transform),local);
console.log("[OK] planar cut plane conversion matches viewport placement");

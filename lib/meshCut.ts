import * as THREE from "three";
import type { StlMesh } from "./stl";

export type CutPoint3 = [number, number, number];
export interface CutPlane { normal: CutPoint3; constant: number }
export interface MeshCutResult {
  positive: StlMesh;
  negative: StlMesh;
  intersectionSegments: number;
  capTriangles: number;
}

type Triangle = [CutPoint3, CutPoint3, CutPoint3];
type Segment = [CutPoint3, CutPoint3];

function distance(plane: CutPlane, point: CutPoint3): number {
  return plane.normal[0] * point[0] + plane.normal[1] * point[1] + plane.normal[2] * point[2] + plane.constant;
}

function interpolate(a: CutPoint3, b: CutPoint3, da: number, db: number): CutPoint3 {
  const t = da / (da - db);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clipPolygon(points: CutPoint3[], plane: CutPlane, positive: boolean, epsilon: number): CutPoint3[] {
  const output: CutPoint3[] = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const da = distance(plane, a), db = distance(plane, b);
    const aInside = positive ? da >= -epsilon : da <= epsilon;
    const bInside = positive ? db >= -epsilon : db <= epsilon;
    if (aInside) output.push(a);
    if (aInside !== bInside) output.push(interpolate(a, b, da, db));
  }
  return output;
}

function area2(triangle: Triangle): number {
  const [a,b,c] = triangle;
  const ab = [b[0]-a[0],b[1]-a[1],b[2]-a[2]];
  const ac = [c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  return Math.hypot(
    ab[1]*ac[2]-ab[2]*ac[1],
    ab[2]*ac[0]-ab[0]*ac[2],
    ab[0]*ac[1]-ab[1]*ac[0],
  );
}

function triangulateFan(polygon: CutPoint3[], epsilonArea: number): Triangle[] {
  const out: Triangle[] = [];
  for (let index = 1; index + 1 < polygon.length; index++) {
    const triangle: Triangle = [polygon[0], polygon[index], polygon[index + 1]];
    if (area2(triangle) > epsilonArea) out.push(triangle);
  }
  return out;
}

function makeMesh(triangles: Triangle[]): StlMesh {
  if (triangles.length === 0) throw new Error("Řez vytvořil prázdnou část modelu.");
  const positions = new Float32Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);
  const min: CutPoint3 = [Infinity,Infinity,Infinity], max: CutPoint3 = [-Infinity,-Infinity,-Infinity];
  triangles.forEach((triangle, index) => {
    const offset = index * 9;
    triangle.forEach((point, vertex) => {
      positions.set(point, offset + vertex * 3);
      for (let axis=0;axis<3;axis++) { min[axis]=Math.min(min[axis],point[axis]); max[axis]=Math.max(max[axis],point[axis]); }
    });
    const a=triangle[0],b=triangle[1],c=triangle[2];
    const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    const n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    const length=Math.hypot(...n)||1;
    for(let vertex=0;vertex<3;vertex++) normals.set([n[0]/length,n[1]/length,n[2]/length],offset+vertex*3);
  });
  return { positions, normals, triangleCount: triangles.length, bounds: { min, max } };
}

function samePoint(a: CutPoint3, b: CutPoint3, epsilon: number): boolean {
  return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]) <= epsilon;
}

function intersectionSegment(triangle: Triangle, plane: CutPlane, epsilon: number): Segment | null {
  const points: CutPoint3[] = [];
  for (let index=0;index<3;index++) {
    const a=triangle[index], b=triangle[(index+1)%3];
    const da=distance(plane,a), db=distance(plane,b);
    if (Math.abs(da)<=epsilon && !points.some((p)=>samePoint(p,a,epsilon))) points.push(a);
    if ((da < -epsilon && db > epsilon) || (da > epsilon && db < -epsilon)) {
      const p=interpolate(a,b,da,db);
      if (!points.some((q)=>samePoint(q,p,epsilon))) points.push(p);
    }
  }
  return points.length === 2 ? [points[0],points[1]] : null;
}

function capFromSegments(segments: Segment[], plane: CutPlane, epsilon: number): { positive: Triangle[]; negative: Triangle[] } {
  if (segments.length === 0) return { positive: [], negative: [] };
  const vertices: CutPoint3[]=[];
  const buckets=new Map<string,number[]>();
  const cell=(value:number)=>Math.floor(value/epsilon);
  const bucketKey=(x:number,y:number,z:number)=>`${x}|${y}|${z}`;
  const vertexFor=(p:CutPoint3)=>{
    const cx=cell(p[0]),cy=cell(p[1]),cz=cell(p[2]);
    let match=-1;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++){
      for(const index of buckets.get(bucketKey(cx+dx,cy+dy,cz+dz))??[]){
        if(samePoint(vertices[index],p,epsilon)&&(match<0||index<match))match=index;
      }
    }
    if(match>=0)return match;
    const index=vertices.length;vertices.push(p);
    const key=bucketKey(cx,cy,cz);buckets.set(key,[...(buckets.get(key)??[]),index]);
    return index;
  };
  const edgeMap=new Map<string,[number,number]>();
  for(const [start,end] of segments){
    const a=vertexFor(start),b=vertexFor(end);
    if(a===b)continue;
    const key=a<b?`${a}|${b}`:`${b}|${a}`;
    if(!edgeMap.has(key))edgeMap.set(key,[a,b]);
  }
  const edges=[...edgeMap.values()];
  const adjacency=new Map<number,number[]>();
  for(const [a,b] of edges){adjacency.set(a,[...(adjacency.get(a)??[]),b]);adjacency.set(b,[...(adjacency.get(b)??[]),a]);}
  if([...adjacency.values()].some((list)=>list.length!==2)) throw new Error("Řez nevytvořil uzavřený obrys pro cap.");
  const loops:number[][]=[]; const used=new Set<string>(); const key=(a:number,b:number)=>a<b?`${a}|${b}`:`${b}|${a}`;
  for(const [start,next0] of edges){if(used.has(key(start,next0)))continue;const loop=[start];let prev=start,current=next0;used.add(key(prev,current));while(current!==start){loop.push(current);const options=adjacency.get(current)!;const next=options[0]===prev?options[1]:options[0];const k=key(current,next);if(used.has(k)&&next!==start)throw new Error("Řez obsahuje nejednoznačný obrys.");used.add(k);prev=current;current=next;if(loop.length>edges.length+1)throw new Error("Řez obsahuje neplatný obrys.");}loops.push(loop);}
  const n=new THREE.Vector3(...plane.normal).normalize(); const helper=Math.abs(n.z)<0.9?new THREE.Vector3(0,0,1):new THREE.Vector3(0,1,0); const u=new THREE.Vector3().crossVectors(helper,n).normalize(); const v=new THREE.Vector3().crossVectors(n,u).normalize();
  const projected=loops.map((loop)=>loop.map((i)=>new THREE.Vector2(new THREE.Vector3(...vertices[i]).dot(u),new THREE.Vector3(...vertices[i]).dot(v))));
  const signed=(ring:THREE.Vector2[])=>ring.reduce((sum,p,i)=>sum+p.x*ring[(i+1)%ring.length].y-ring[(i+1)%ring.length].x*p.y,0)/2;
  const pointIn=(p:THREE.Vector2,ring:THREE.Vector2[])=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if(((a.y>p.y)!==(b.y>p.y))&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;};
  const parent=projected.map((ring,i)=>{let best=-1,bestArea=Infinity;for(let j=0;j<projected.length;j++){if(i===j||!pointIn(ring[0],projected[j]))continue;const area=Math.abs(signed(projected[j]));if(area<bestArea){best=j;bestArea=area;}}return best;});
  const depth=(i:number):number=>parent[i]<0?0:depth(parent[i])+1;
  const positive:Triangle[]=[];
  for(let outer=0;outer<loops.length;outer++){if(depth(outer)%2!==0)continue;let contour=projected[outer], contourIds=loops[outer];if(signed(contour)<0){contour=[...contour].reverse();contourIds=[...contourIds].reverse();}const holeIndices=loops.map((_,i)=>i).filter((i)=>parent[i]===outer&&depth(i)%2===1);const holes=holeIndices.map((i)=>signed(projected[i])>0?[...projected[i]].reverse():projected[i]);const holeIds=holeIndices.map((i)=>signed(projected[i])>0?[...loops[i]].reverse():loops[i]);const faces=THREE.ShapeUtils.triangulateShape(contour,holes);const flatIds=[...contourIds,...holeIds.flat()];for(const [a,b,c] of faces)positive.push([vertices[flatIds[a]],vertices[flatIds[b]],vertices[flatIds[c]]]);}
  const desiredPositiveNormal=n.clone().negate();
  for(const tri of positive){const a=new THREE.Vector3(...tri[0]),b=new THREE.Vector3(...tri[1]),c=new THREE.Vector3(...tri[2]);const normal=new THREE.Vector3().crossVectors(b.sub(a),c.sub(a));if(normal.dot(desiredPositiveNormal)<0)[tri[1],tri[2]]=[tri[2],tri[1]];}
  const negative=positive.map(([a,b,c])=>[a,c,b] as Triangle);
  return { positive, negative };
}

export function cutMeshByPlane(mesh: StlMesh, rawPlane: CutPlane, options: { cap?: boolean } = {}): MeshCutResult {
  const length=Math.hypot(...rawPlane.normal);
  if(!Number.isFinite(length)||length<=0||!Number.isFinite(rawPlane.constant))throw new Error("Řezná rovina není platná.");
  const plane:CutPlane={normal:[rawPlane.normal[0]/length,rawPlane.normal[1]/length,rawPlane.normal[2]/length],constant:rawPlane.constant/length};
  const diagonal=Math.hypot(mesh.bounds.max[0]-mesh.bounds.min[0],mesh.bounds.max[1]-mesh.bounds.min[1],mesh.bounds.max[2]-mesh.bounds.min[2]);
  const epsilon=Math.max(1e-7,diagonal*1e-8), epsilonArea=Math.max(1e-14,diagonal*diagonal*1e-14);
  const positive:Triangle[]=[],negative:Triangle[]=[],segments:Segment[]=[];
  for(let index=0;index<mesh.triangleCount;index++){
    const o=index*9;
    const tri:Triangle=[[mesh.positions[o],mesh.positions[o+1],mesh.positions[o+2]],[mesh.positions[o+3],mesh.positions[o+4],mesh.positions[o+5]],[mesh.positions[o+6],mesh.positions[o+7],mesh.positions[o+8]]];
    const ds=tri.map((p)=>distance(plane,p));
    const pos=ds.some((d)=>d>epsilon),neg=ds.some((d)=>d<-epsilon);
    if(!pos&&!neg){
      const ab=new THREE.Vector3(...tri[1]).sub(new THREE.Vector3(...tri[0]));
      const ac=new THREE.Vector3(...tri[2]).sub(new THREE.Vector3(...tri[0]));
      (new THREE.Vector3().crossVectors(ab,ac).dot(new THREE.Vector3(...plane.normal))>=0?positive:negative).push(tri);
      continue;
    }
    const segment=intersectionSegment(tri,plane,epsilon);
    if(segment)segments.push(segment);
    if(pos&&!neg){positive.push(tri);continue;}
    if(neg&&!pos){negative.push(tri);continue;}
    positive.push(...triangulateFan(clipPolygon(tri,plane,true,epsilon),epsilonArea));
    negative.push(...triangulateFan(clipPolygon(tri,plane,false,epsilon),epsilonArea));
  }
  if(segments.length===0)throw new Error("Řezná rovina model neprotíná.");
  let capTriangles=0;if(options.cap!==false){const cap=capFromSegments(segments,plane,Math.max(1e-5,diagonal*1e-7));positive.push(...cap.positive);negative.push(...cap.negative);capTriangles=cap.positive.length+cap.negative.length;}
  return {positive:makeMesh(positive),negative:makeMesh(negative),intersectionSegments:segments.length,capTriangles};
}

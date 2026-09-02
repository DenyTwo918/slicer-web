import { cutMeshByPlane, type CutPlane, type MeshCutResult } from "./meshCut";
import type { StlMesh } from "./stl";
export interface MeshCutWorkerRequest{requestId:number;modelId:number;revision:number;mesh:StlMesh;plane:CutPlane;cap:boolean}
export interface MeshCutWorkerResponse{requestId:number;modelId:number;revision:number;ok:boolean;result?:MeshCutResult;error?:string}
const ctx=self as unknown as{postMessage:(message:MeshCutWorkerResponse)=>void;onmessage:((event:MessageEvent<MeshCutWorkerRequest>)=>void)|null};
ctx.onmessage=(event)=>{const{requestId,modelId,revision,mesh,plane,cap}=event.data;try{ctx.postMessage({requestId,modelId,revision,ok:true,result:cutMeshByPlane(mesh,plane,{cap})});}catch(error){ctx.postMessage({requestId,modelId,revision,ok:false,error:error instanceof Error?error.message:"Řez modelu selhal."});}};

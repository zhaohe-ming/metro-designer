import { getToken, MapSummary, UserDto } from '../api';
import { Line, Station, Section, MapSettings } from '../types';
export type Graph = {lines:Line[];stations:Station[];sections:Section[];mapSettings:MapSettings};
export type Crop = {zoom:number;x:number;y:number};
export type Metadata = {title:string;description:string;city:string;category:'real'|'fictional'|'concept';allowFork:boolean;includeNotes:boolean;coverCrop:Crop};
export type Work = Metadata & {id:string;author:{name:string;avatar?:string;official?:boolean};counts:{lines:number;stations:number;sections:number};
  featured:boolean;example:boolean;baseMap:'plain'|'amap';revision:string;publishedAt:string;updatedAt:string;
  visibility:'public'|'withdrawn'|'hidden';hasPublished?:boolean;sourceMapId?:string;reviewStatus?:'pending'|'approved'|'returned';reviewNote?:string;version?:number;
  likes:number;saves:number;liked:boolean;saved:boolean;snapshot?:Graph;origin?:{id:string;title:string;author:string;revision:string}};
export type GalleryUser = Pick<UserDto,'id'|'username'|'avatar'>;
export type Report = {id:string;workId:string;payload:{reason:string;note:string;resolved:boolean;createdAt:string}};
const BASE=(process.env.REACT_APP_API_BASE_URL||'').replace(/\/$/,'');
export const categoryNames={real:'现实城市',fictional:'架空城市',concept:'规划设想'};
async function request<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const token=getToken();const response=await fetch(`${BASE}/api/gallery${path}`,{method,signal,
    headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'加载失败，请重试');return data;
}
export const gallery={
  list:(params:URLSearchParams,signal?:AbortSignal)=>request<{works:Work[];total:number;page:number}>(`/works?${params}`,'GET',undefined,signal),
  detail:(id:string,signal?:AbortSignal)=>request<{work:Work}>(`/works/${encodeURIComponent(id)}`,'GET',undefined,signal),
  mine:()=>request<{works:Work[]}>('/mine'),
  session:()=>request<{admin:boolean}>('/session'),
  admin:()=>request<{works:Work[];reports:Report[]}>('/admin'),
  reviewDetail:(id:string)=>request<{work:Work}>(`/admin/works/${id}`),
  submit:(sourceMapId:string,meta:Metadata,work?:Work)=>request<{work:Work}>(work?`/works/${work.id}`:'/works',work?'PUT':'POST',{sourceMapId,...meta,...(work?{version:work.version}:{})}),
  withdraw:(work:Work)=>request(`/works/${work.id}/withdraw`,'POST',{version:work.version}),
  react:(id:string,kind:'like'|'save',active:boolean)=>request<Pick<Work,'likes'|'saves'|'liked'|'saved'>>(`/works/${id}/reactions`,'PUT',{kind,active}),
  fork:(id:string)=>request<{name:string;snapshot:Graph;sourceToken:string;origin:NonNullable<Work['origin']>}>(`/works/${id}/fork`,'POST'),
  report:(id:string,reason:string,note:string)=>request(`/works/${id}/report`,'POST',{reason,note}),
  review:(work:Work,action:string,note='')=>request(`/admin/works/${work.id}/review`,'POST',{version:work.version,action,note}),
  resolve:(id:string)=>request(`/admin/reports/${id}/resolve`,'POST'),
  cover:(work:Work)=>`${BASE}/api/gallery/works/${encodeURIComponent(work.id)}/cover?v=${encodeURIComponent(work.revision)}`,
  preview:async(sourceMapId:string,meta:Metadata,signal:AbortSignal,diagramOnly=false)=>{
    const response=await fetch(`${BASE}/api/gallery/preview`,{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${getToken()}`},body:JSON.stringify({sourceMapId,...meta,diagramOnly})});
    if(!response.ok){const data=await response.json();throw new Error(data.message||'封面加载失败');}return response.blob();
  }
};
export type PrivateMap = MapSummary;

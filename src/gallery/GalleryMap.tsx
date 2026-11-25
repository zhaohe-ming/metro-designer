import React, {useEffect,useMemo,useRef,useState} from 'react';
import {Button,Tooltip} from 'antd';
import {FullscreenOutlined,FullscreenExitOutlined,PlusOutlined,MinusOutlined,CompressOutlined} from '@ant-design/icons';
import Canvas from '../components/Canvas';
import {Graph} from './api';
import {AppAction} from '../lib/commandParser';
import {migrateLegacyGcj02MapToWgs84} from '../lib/coordTransform';
import {normalizeMapSettings} from '../types';
const noop=()=>{};
export default function GalleryMap({graph,id}:{graph:Graph;id:string}){
  const root=useRef<HTMLDivElement>(null);
  const [full,setFull]=useState(false),[command,setCommand]=useState<{seq:number;action:AppAction}|null>(null);
  const normalizedGraph=useMemo(()=>{
    const migrated=migrateLegacyGcj02MapToWgs84({
      stations:graph.stations||[],
      sections:graph.sections||[],
      mapSettings:normalizeMapSettings(graph.mapSettings)
    });
    return {...graph,stations:migrated.stations,sections:migrated.sections,mapSettings:migrated.mapSettings};
  },[graph]);
  useEffect(()=>{
    if(!full)return;
    const previous=document.body.style.overflow;document.body.style.overflow='hidden';
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setFull(false);};
    window.addEventListener('keydown',close);
    return()=>{document.body.style.overflow=previous;window.removeEventListener('keydown',close);};
  },[full]);
  const view=(type:'zoom_in'|'zoom_out'|'fit')=>setCommand({seq:Date.now(),action:{type}});
  return <div ref={root} className={`gallery-map${full?' gallery-map--full':''}`}>
    <Canvas {...normalizedGraph} documentKey={`public-${id}`} readOnly currentLineId={null} fitOnMount
      onAddStation={noop} onUpdateStation={noop} onAddStationToLine={noop} onRenameStation={noop}
      onDeleteSection={noop} onReorderStations={noop} onDeleteStation={noop} viewCommand={command}/>
    <div className="gallery-map-tools"><Tooltip title={full?'退出全屏':'放大地图'}><Button aria-label={full?'退出全屏':'放大地图'} icon={full?<FullscreenExitOutlined/>:<FullscreenOutlined/>} onClick={()=>setFull(!full)}/></Tooltip>
      <Button aria-label="放大" icon={<PlusOutlined/>} onClick={()=>view('zoom_in')}/><Button aria-label="缩小" icon={<MinusOutlined/>} onClick={()=>view('zoom_out')}/><Button aria-label="适应线网" icon={<CompressOutlined/>} onClick={()=>view('fit')}/></div>
    <span className="gallery-map-caption">点站点查看 · 拖拽缩放</span>
  </div>;
}

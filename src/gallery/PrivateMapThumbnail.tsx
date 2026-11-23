import React,{useEffect,useState} from 'react';
import {gallery,PrivateMap,Metadata} from './api';
const meta:Metadata={title:'私人地图预览',category:'fictional',description:'',city:'',allowFork:false,includeNotes:false,coverCrop:{zoom:1,x:0,y:0}};
export default function PrivateMapThumbnail({map}:{map:PrivateMap}){
  const [url,setUrl]=useState('');
  useEffect(()=>{if(!map.lineCount||!map.stationCount)return;const controller=new AbortController();let image='';
    gallery.preview(map.id,meta,controller.signal,true).then(blob=>{image=URL.createObjectURL(blob);setUrl(image);}).catch(()=>{});
    return()=>{controller.abort();if(image)URL.revokeObjectURL(image);};
  },[map.id,map.updatedAt,map.lineCount,map.stationCount]);
  return <div className="gallery-private-thumb">{url?<img src={url} alt={`${map.name}预览`}/>:<span>私人存档</span>}</div>;
}

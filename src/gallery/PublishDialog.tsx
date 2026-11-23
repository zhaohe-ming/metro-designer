import React,{useEffect,useState} from 'react';
import {Modal,Input,Select,Radio,Checkbox,Button,Slider,Alert,message} from 'antd';
import {gallery,Metadata,Work,GalleryUser,categoryNames} from './api';
const defaults:Metadata={title:'',description:'',city:'',category:'fictional',allowFork:false,includeNotes:false,coverCrop:{zoom:1,x:0,y:0}};
export default function PublishDialog({source,user,onClose,onDone}:{source:{id:string;name:string;work?:Work}|null;user:GalleryUser|null;onClose:()=>void;onDone:()=>void}){
  const [form,setForm]=useState<Metadata>(defaults),[cover,setCover]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[adjust,setAdjust]=useState(false);
  useEffect(()=>{if(!source)return;setForm(source.work?{...defaults,...source.work,includeNotes:false,coverCrop:source.work.coverCrop||defaults.coverCrop}:{...defaults,title:source.name});setError('');setCover('');setAdjust(false);},[source]);
  const sourceId=source?.id;
  useEffect(()=>{
    if(!sourceId)return;const controller=new AbortController();let url='';setLoading(true);
    const timeout=window.setTimeout(()=>{gallery.preview(sourceId,{...defaults,coverCrop:form.coverCrop},controller.signal).then(blob=>{url=URL.createObjectURL(blob);setCover(url);setError('');}).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});},240);
    return()=>{controller.abort();clearTimeout(timeout);if(url)URL.revokeObjectURL(url);};
  },[sourceId,form.coverCrop]);
  const patch=(value:Partial<Metadata>)=>setForm(prev=>({...prev,...value}));
  async function submit(){if(!source||!form.title.trim()){setError('请填写作品标题');return;}if(!cover||error){setError(error||'请等待封面加载完成');return;}setBusy(true);try{await gallery.submit(source.id,form,source.work);message.success('已提交审核，可在我的作品中查看进度');onDone();onClose();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  return <Modal open={!!source} onCancel={onClose} footer={null} width={1020} className="gallery-publish" title={<h2>发布到作品广场</h2>} destroyOnHidden>
    <div className="gallery-publish-grid"><div className="gallery-publish-fields">
      <label>作品标题<Input value={form.title} maxLength={60} onChange={e=>patch({title:e.target.value})}/></label>
      <div className="gallery-two-fields"><label>作品类型<Select value={form.category} onChange={category=>patch({category})} options={Object.entries(categoryNames).map(([value,label])=>({value,label}))}/></label><label>城市名称 <span>选填</span><Input value={form.city} maxLength={40} onChange={e=>patch({city:e.target.value})}/></label></div>
      <label>作品简介<Input.TextArea value={form.description} maxLength={800} rows={4} showCount onChange={e=>patch({description:e.target.value})} placeholder="介绍你的线网和设计想法"/></label>
      <fieldset><legend>使用权限</legend><Radio.Group value={form.allowFork} onChange={e=>patch({allowFork:e.target.value})}><Radio value={false}>仅供展示</Radio><Radio value={true}>允许复制再创作</Radio></Radio.Group><p>复制将保留原作名称、作者和来源链接。</p></fieldset>
      <fieldset><legend>公开内容</legend><Checkbox checked disabled>线路、站点与站名</Checkbox><Checkbox checked={form.includeNotes} onChange={e=>patch({includeNotes:e.target.checked})}>包含站点备注</Checkbox><p>公开展示昵称、头像与所选内容。私人原稿独立保存。</p></fieldset>
    </div><div className="gallery-cover-preview"><h3>封面预览</h3><div className="gallery-cover-frame">{cover?<img src={cover} alt="作品封面预览"/>:<span>{loading?'正在生成线网封面…':'封面暂未加载'}</span>}</div>
      <Button type="link" onClick={()=>setAdjust(!adjust)}>调整封面取景</Button>
      {adjust?<div className="gallery-crop"><label>放大<Slider min={1} max={3} step={.05} value={form.coverCrop.zoom} onChange={zoom=>patch({coverCrop:{...form.coverCrop,zoom}})}/></label><label>水平位置<Slider min={-1} max={1} step={.02} value={form.coverCrop.x} onChange={x=>patch({coverCrop:{...form.coverCrop,x}})}/></label><label>垂直位置<Slider min={-1} max={1} step={.02} value={form.coverCrop.y} onChange={y=>patch({coverCrop:{...form.coverCrop,y}})}/></label></div>:null}
      <h3>{form.title||'作品标题'}</h3><p>{user?.username||'线网设计者'} · {categoryNames[form.category]}</p><small>封面由当前保存的线网生成</small>
    </div></div>
    {error?<Alert type="error" showIcon message={error}/>:null}
    <div className="gallery-modal-footer"><span>提交后审核，通过后公开展示。</span><div><Button onClick={onClose}>取消</Button><Button type="primary" loading={busy} disabled={loading} onClick={()=>void submit()}>提交审核</Button></div></div>
  </Modal>;
}

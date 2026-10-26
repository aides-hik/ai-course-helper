'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname,'..','ai-images.js'),'utf8');
const sandbox = {URL,AbortController,setTimeout,clearTimeout};
vm.runInNewContext(source+'\nglobalThis.api={descriptors:aiQuestionImageDescriptors,collect:aiCollectQuestionImages,data:aiImageDataUrl,load:aiImageLoadState,encode:aiImageEncodePixels};',sandbox);
const {api} = sandbox;
const marker = (index)=>`\uFFFC[ai-image:${index}]\uFFFC`;
const png = (bytes=12)=>{
  const content=Buffer.alloc(bytes);Buffer.from([137,80,78,71,13,10,26,10]).copy(content);
  return 'data:image/png;base64,'+content.toString('base64');
};
const document = {baseURI:'https://learn.example/course/chapter.html'};
function image(attributes={}, options={}) {
  return {tagName:'IMG',ownerDocument:document,getAttribute:(name)=>attributes[name]??null,...options};
}
function question(images, extra={}) {
  return {title:'raw question',type:'0',optionsText:['A','B'],
    element:{ownerDocument:document,querySelectorAll:()=>images},
    searchText:{stem:images.map((_,index)=>marker(index)).join(' '),options:['A','B'],images:images.map((element,index)=>({marker:marker(index),label:index?'选项1':'题干',element}))},...extra};
}

test('markers identify each image and preserve their stem and option labels',async()=>{
  const entries=[image({src:'./stem.png'}),image({src:'../choices/b.jpg'})];
  const entry=question(entries);
  entry.searchText.stem='Question '+marker(0);entry.searchText.options=['A '+marker(1),'B'];
  const result=await api.collect(entry);
  assert.equal(result.images.length,2);
  assert.deepEqual(Array.from(result.images,(item)=>[item.marker,item.label,item.url]),[
    [marker(0),'题干','https://learn.example/course/stem.png'],[marker(1),'选项1','https://learn.example/choices/b.jpg']]);
});

test('missing, duplicated, reordered or unbound markers reject the entire question',()=>{
  const make=()=>question([image({src:'https://public.example/a.png'})]);
  for(const mutate of [
    (q)=>q.searchText.images=[],(q)=>q.searchText.stem='',
    (q)=>q.searchText.stem+=marker(0),(q)=>q.searchText.images[0].marker=marker(2),
    (q)=>q.searchText.images[0].element.tagName='SVG',
    (q)=>q.searchText.images='invalid']){
    const entry=make();mutate(entry);assert.ok(api.descriptors(entry).error);
  }
  const entry=question([image({src:'a.png'}),image({src:'b.png'})]);
  entry.searchText.images.reverse();assert.ok(api.descriptors(entry).error);
});

test('plain literal img text stays text while legacy actual image markup and visual nodes reject',()=>{
  const literal=question([]);literal.searchText.stem='Discuss the literal <img src="example"> in this code';
  assert.equal(api.descriptors(literal).images.length,0);
  delete literal.searchText.images;assert.ok(api.descriptors(literal).error);
  const unsupported=question([]);unsupported.searchText.stem='\uFFFC[ai-visual:canvas]\uFFFC';
  assert.ok(api.descriptors(unsupported).error);
});

test('metadata omissions cannot quietly drop a real DOM image',()=>{
  const entry=question([image({src:'x.png'})]);
  entry.searchText={stem:'plain title',options:['A','B'],images:[]};
  assert.ok(api.descriptors(entry).error);
});

test('unsupported visuals outside an option text span reject instead of sending incomplete text',()=>{
  for(const kind of ['svg','canvas','background']){
    const entry=question([]);
    const visual=kind==='background'?{tagName:'SPAN',style:{backgroundImage:'url(diagram.png)'}}:{tagName:kind.toUpperCase()};
    entry.options={A:{tagName:'DIV',children:[{tagName:'SPAN',textContent:'label'},visual]}};
    assert.ok(api.descriptors(entry).error,kind);
  }
});

test('answer editor graphics and iframes do not make an otherwise textual question unsupported',()=>{
  const entry=question([]);
  entry.options={};
  entry.element.querySelectorAll=(selector)=>selector==='img'?[]:[{tagName:'H3',children:[{tagName:'INPUT'},{tagName:'DIV',getAttribute:(name)=>name==='contenteditable'?'true':null,children:[{tagName:'CANVAS'},{tagName:'IFRAME'}]}]}];
  assert.equal(api.descriptors(entry).error,undefined);
});

test('lazy sources and responsive currentSrc are resolved without loading another resource',async()=>{
  const lazy=image({src:'loading.gif','data-src':'answers/actual.png'},{currentSrc:'https://learn.example/course/loading.gif'});
  assert.equal((await api.collect(question([lazy]))).images[0].url,'https://learn.example/course/answers/actual.png');
  const responsive=image({src:'small.png',srcset:'large.png 2x','data-src':'old.png'},{currentSrc:'https://images.example/large.png'});
  assert.equal((await api.collect(question([responsive]))).images[0].url,'https://images.example/large.png');
  const detached=image({src:'relative.png'},{ownerDocument:{baseURI:'https://wrong.example/'}});
  assert.equal((await api.collect(question([detached]))).images[0].url,'https://learn.example/course/relative.png');
});

test('allowed image data formats validate both base64 and their file signatures',async()=>{
  const formats=[
    png(),
    'data:image/jpeg;base64,'+Buffer.from([255,216,255,224]).toString('base64'),
    'data:image/gif;base64,'+Buffer.from('GIF89a1234').toString('base64'),
    'data:image/webp;base64,'+Buffer.from('RIFF1234WEBP1234').toString('base64')];
  for(const source of formats)assert.equal((await api.collect(question([image({src:source})]))).images[0].url,source);
  for(const invalid of [
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,abc',
    'data:image/png;base64,PHN2Zz4=', 'data:image/png;base64,ab===',
    'data:image/png;base64,a===','data:image/png;base64,ab==',
    'data:image/png;base64,iVBORw0KGgo=\n'])assert.ok(api.data(invalid).error,invalid);
});

test('a loaded browser-readable image is embedded as pixels, including protected URLs',async()=>{
  let drawn=0;
  const encoded=png(24);
  const img=image({src:'https://learn.example/protected.png?token=fixture'},{complete:true,naturalWidth:2,naturalHeight:3,currentSrc:'https://learn.example/protected.png?token=fixture',
    ownerDocument:{...document,createElement:()=>({getContext:()=>({drawImage(){drawn++;}}),toDataURL:()=>encoded})}});
  const result=await api.collect(question([img]));
  assert.equal(drawn,1);assert.equal(result.images[0].url,encoded);
});

test('a tainted canvas falls back to the sanitized public URL without cookies or userinfo',async()=>{
  const src='https://person:password@images.example/a.png?asset=1#private-fragment';
  const img=image({src},{complete:true,naturalWidth:2,naturalHeight:3,currentSrc:src,
    ownerDocument:{...document,createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL(){throw new Error('tainted');}})}});
  const result=await api.collect(question([img]));
  assert.equal(result.images[0].url,'https://images.example/a.png?asset=1');
  assert.ok(!JSON.stringify(result).includes('password'));
});

test('loaded temporary blob images may be embedded but blob addresses never leave the browser',async()=>{
  const src='blob:https://learn.example/temporary-image';
  const img=image({src},{complete:true,naturalWidth:2,naturalHeight:3,currentSrc:src,
    ownerDocument:{...document,createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL:()=>png()})}});
  assert.equal((await api.collect(question([img]))).images[0].url,png());
  img.ownerDocument.createElement=()=>{throw new Error('not readable');};
  assert.ok((await api.collect(question([img]))).error);
});

test('unsupported schemes, missing sources, SVG URLs and private fallback addresses reject',async()=>{
  for(const src of ['', 'javascript:alert(1)','file:///private.png','blob:https://learn.example/id','https://images.example/diagram.svg',
    'http://127.0.0.1/image.png','http://[::ffff:127.0.0.1]/image.png','http://192.168.1.2/image.png']){
    const result=await api.collect(question([image({src})]));assert.ok(result.error,src);
    assert.ok(!result.error.includes(src)||src==='');
  }
});

test('image count, per-image bytes, dimensions and total embedded bytes have hard bounds',async()=>{
  assert.ok(api.descriptors(question(Array.from({length:21},()=>image({src:'x.png'})))).error);
  assert.ok(api.data(png(8*1024*1024+1)).error);
  const oversize=image({src:'https://images.example/large.png'},{naturalWidth:100000,naturalHeight:100000});
  assert.ok((await api.collect(question([oversize]))).error);
  const big=png(7*1024*1024);
  const result=await api.collect(question([image({src:big}),image({src:big}),image({src:big})]));
  assert.ok(result.error.includes('20 MiB'));
});

test('cancellation before or between images settles without leaking partial images',async()=>{
  const controller=new AbortController();controller.abort();
  assert.equal((await api.collect(question([image({src:'a.png'})]),{signal:controller.signal})).error,'请求已取消');
  let checks=0;
  const result=await api.collect(question([image({src:'a.png'}),image({src:'b.png'})]),{isCurrent:()=>++checks<3});
  assert.equal(result.error,'请求已取消');assert.equal(result.images,undefined);
});

test('an image wait removes its load, error and abort listeners when cancelled',async()=>{
  const listeners=new Map();
  const pending={complete:false,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name)=>listeners.delete(name)};
  const controller=new AbortController();
  const loading=api.load(pending,{signal:controller.signal},Date.now()+15000,3000);
  assert.equal(listeners.size,2);controller.abort();
  assert.equal((await loading).error,'请求已取消');
  assert.equal(listeners.size,0);
});

test('the shared image deadline clears pending polling and listeners',async()=>{
  let now=0,id=0;
  const timers=new Map(),listeners=new Map();
  const local={URL,Date:{now:()=>now},setTimeout:(fn)=>{timers.set(++id,fn);return id;},clearTimeout:(key)=>timers.delete(key)};
  vm.runInNewContext(source+'\nglobalThis.load=aiImageLoadState;',local);
  const loading=local.load({complete:false,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name)=>listeners.delete(name)}, {},15000,5000);
  now=15001;for(const callback of [...timers.values()])callback();
  assert.ok((await loading).error.includes('超时'));
  assert.equal(timers.size,0);assert.equal(listeners.size,0);
});

test('an original image changing source during its load never supplies the old marker with new pixels',async()=>{
  let drawing=0;
  const listeners=new Map();
  const img=image({src:'https://images.example/old.png'},{src:'https://images.example/old.png',currentSrc:'https://images.example/old.png',complete:false,
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name)=>listeners.delete(name),
    ownerDocument:{...document,createElement:()=>({getContext:()=>({drawImage(){drawing++;}}),toDataURL:()=>png()})}});
  const loading=api.collect(question([img]));
  img.src='https://images.example/new.png';img.currentSrc=img.src;img.complete=true;img.naturalWidth=10;img.naturalHeight=10;
  listeners.get('load')();
  const result=await loading;
  assert.equal(drawing,0);assert.equal(result.images[0].url,'https://images.example/old.png');
});

test('JPEG compression fills transparent pixels with white before encoding',()=>{
  const operations=[];
  const drawing={drawImage(){},fillRect(){operations.push([this.globalCompositeOperation,this.fillStyle]);}};
  const doc={createElement:()=>({getContext:()=>drawing,toDataURL:(mime)=>mime==='image/png'?png(8*1024*1024+1):'data:image/jpeg;base64,/9j/4A=='})};
  const encoded=api.encode({naturalWidth:10,naturalHeight:10},doc,8192);
  assert.equal(encoded.error,undefined);assert.ok(encoded.url.startsWith('data:image/jpeg;'));
  assert.deepEqual(operations,[['destination-over','#ffffff']]);
  assert.equal(drawing.globalCompositeOperation,'source-over');
});

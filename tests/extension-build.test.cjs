'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'dist/ai-course-helper-extension');
const version=JSON.parse(fs.readFileSync(path.join(output,'manifest.json'),'utf8')).version;
test('MV3 manifest loads packaged runtime dependencies and keeps privileged application isolated',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version,3);assert.equal(manifest.minimum_chrome_version,'116');
  assert.deepEqual(manifest.permissions,['storage','offscreen','alarms']);assert.equal(manifest.web_accessible_resources,undefined);
  for(const group of manifest.content_scripts){for(const file of group.js){assert.ok(!file.includes('://'));assert.ok(fs.existsSync(path.join(output,file)));}}
  const main=manifest.content_scripts.find(v=>v.world==='MAIN'),isolated=manifest.content_scripts.find(v=>v.world==='ISOLATED');
  assert.deepEqual(main.js,['page-main.js']);assert.equal(isolated.all_frames,false);
  const content=fs.readFileSync(path.join(output,'content.js'),'utf8');
  assert.doesNotMatch(content,/@require|@resource|==UserScript==/);
  assert.match(content,/extensionFlushStorage\(\); window\.location\.reload\(\)/);
  assert.doesNotMatch(content,/await iframeWindow\.(noSubmit|btnBlueSubmit|submitCheckTimes)\(/);
  const page=fs.readFileSync(path.join(output,'page-main.js'),'utf8');
  assert.doesNotMatch(page,/chrome\.storage|GM_xmlhttpRequest|Bearer |apiKey/);
});
test('source-only offline rebuild reproduces the identical extension archive',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'course-extension-build-'));
  try{
    for(const name of fs.readdirSync(root)){if(name.endsWith('.js')||name==='build_ai.py'||name==='build_extension.py'||name==='userscript.template.js.in'||name==='ui-panel.css')fs.copyFileSync(path.join(root,name),path.join(temporary,name));}
    fs.cpSync(path.join(root,'extension'),path.join(temporary,'extension'),{recursive:true});
    const result=spawnSync('python',[path.join(temporary,'build_extension.py')],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(temporary,`dist/ai-course-helper-extension-${version}.zip`)),fs.readFileSync(path.join(root,`dist/ai-course-helper-extension-${version}.zip`)));
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

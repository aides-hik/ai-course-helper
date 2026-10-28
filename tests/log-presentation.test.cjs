'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../log-presentation.js'),'utf8')+'\nglobalThis.api={rows:logVisibleRows,overview:logOverview,reminder:logReminder};',context);
const {rows,overview,reminder}=context.api;
const entry=(message,type='info',time='12:00:00')=>({message,type,time});
const snapshot=(total=1,done=0)=>entry(`[章节诊断] 扫描状态：2 个页面，${total} 个任务，${done} 个已确认；自动跳章=开，只答题=关`);
test('a normally playing unfinished video is running rather than an exception',()=>{
  const logs=[snapshot(),entry('[章节诊断] 页面#2 视频；播放=12/90秒，结束=否，暂停=否；阻塞=未识别到平台完成标记','warning'),entry('[章节诊断] 当前原因：页面#2：未识别到平台完成标记；任务下一步=可用','warning')];
  const status=overview(logs);
  assert.equal(status.state,'running');assert.equal(status.badge,'进行中');assert.match(status.note,/正在播放/);assert.equal(reminder(logs[2]),false);
  assert.equal(rows(logs,'brief').length,0);assert.equal(rows(logs,'detail').length,3);
  assert.equal(rows([entry('发现一个video，正在解析')],'brief')[0].displayMessage,'已找到视频任务，准备播放。');
});
test('ended video waits for platform confirmation while inaccessible tasks require review',()=>{
  const logs=[snapshot(),entry('[章节诊断] 页面#2 视频；播放=90/90秒，结束=是，暂停=是；阻塞=未识别到平台完成标记'),entry('[章节诊断] 当前原因：页面#2：未识别到平台完成标记；任务下一步=可用')];
  assert.equal(overview(logs).badge,'等待平台确认');assert.equal(overview(logs).state,'waiting');
  logs.push(entry('[章节诊断] 当前原因：页面#3：不可访问；任务下一步=可用','warning'));
  assert.equal(overview(logs).state,'attention');assert.equal(reminder(logs.at(-1)),true);
});
test('brief view coalesces equivalent consecutive visible messages without modifying source diagnostics',()=>{
  const logs=[entry('[章节诊断] 当前原因：平台任务已完成，自动跳章开关关闭；任务下一步=可用','primary'),entry('[章节诊断] 页面#2 视频；原始src=private-internal-state'),entry('[章节诊断] 当前原因：平台任务已完成，自动跳章开关关闭；任务下一步=可用','primary','12:00:30')];
  const before=JSON.stringify(logs),brief=rows(logs,'brief');assert.equal(brief.length,1);assert.equal(brief[0].repeat,2);assert.equal(brief[0].lastTime,'12:00:30');assert.equal(rows(logs,'detail').length,3);assert.equal(JSON.stringify(logs),before);
});
test('reminders omit ordinary progress, optional AI configuration and per-frame diagnostics',()=>{
  const logs=[entry('发现一个video，正在解析','warning'),entry('AI 未配置：剩余题目可手动完成。'),entry('第 2 道题未完成，请到「解题」页签查看原因','warning'),entry('[章节诊断] 页面#2 视频；阻塞=未识别到平台完成标记','warning'),entry('任务处理失败，请检查页面状态','danger')];
  const visible=rows(logs,'reminders');assert.equal(visible.length,2);assert.match(visible[0].displayMessage,/第 2 道题/);assert.equal(logs.length,5);
});
test('standalone answer overview uses actual question status and avoids claiming correctness',()=>{
  const questions=[{answerStatus:'success'},{answerStatus:'pending',answerSource:'configuration'}];
  assert.equal(overview([],questions).badge,'可手动作答');assert.equal(overview([],questions).progress,'1 / 2');
  questions[1].answerStatus='success';const status=overview([],questions);assert.equal(status.badge,'已填写');assert.match(status.note,/请核对/);assert.doesNotMatch(status.note,/正确/);
});
test('raw text remains literal and brief repeat merging respects a one-minute window',()=>{
  const text='<img src=x onerror=alert(1)>',logs=[entry(text),entry(text,'info','12:01:01')];
  assert.equal(rows(logs).length,2);assert.equal(rows(logs,'detail')[0].displayMessage,text);
  assert.equal(overview([snapshot(1,1)]).state,'complete');
});

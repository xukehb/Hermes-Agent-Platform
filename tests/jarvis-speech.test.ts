import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect,vi} from 'vitest';
const source=readFileSync('src/gui/renderer/jarvis-speech.js','utf8');
function engine(){
  const utterances: Array<{onend:()=>void;onstart:()=>void;voice?:{name:string}}> = [];
  const voices=[{name:'Generic',lang:'zh-CN'},{name:'Yunxi',lang:'zh-CN'}];
  const audios: any[]=[];
  const window={dispatchEvent:vi.fn(),speechSynthesis:{getVoices:()=>voices,cancel:vi.fn(),speak:(u:typeof utterances[number])=>utterances.push(u)},jarvisSpeech:undefined as any};
  runInNewContext(source,{window,Audio:class {onended=()=>{};onerror=()=>{};play=vi.fn().mockResolvedValue(undefined);pause=vi.fn();removeAttribute=vi.fn();constructor(public src:string){audios.push(this);}},CustomEvent:class{constructor(public type:string,public options:unknown){}},SpeechSynthesisUtterance:class {constructor(public text:string){}},console});
  return {speech:window.jarvisSpeech,utterances,audios,window};
}
describe('Jarvis playback lifecycle',()=>{
  it('settles a cancelled utterance even when the browser never emits onend',async()=>{
    const {speech}=engine();let settled=false;
    void speech.speak('你好').then(()=>{settled=true;});speech.cancel();await Promise.resolve();expect(settled).toBe(true);
  });
  it('does not let a cancelled utterance clear the next speech state',()=>{
    const {speech,utterances}=engine();void speech.speak('第一段');void speech.speak('第二段');utterances[1]!.onstart();utterances[0]!.onend();expect(speech.isSpeaking()).toBe(true);
  });
  it('prefers the named Chinese voice before a generic Chinese fallback',()=>{
    const {speech,utterances}=engine();void speech.speak('你好');expect(utterances[0]!.voice?.name).toBe('Yunxi');
  });
});

describe('Jarvis cloud playback',()=>{
  it('ignores a synthesize result that arrives after cancellation',async()=>{
    const {speech}=engine();let release: (value:unknown)=>void = ()=>{};
    speech.cloudSettings={provider:'tencent',fallbackToLocal:false};
    speech.cloudApi={synthesizeSpeech:vi.fn(()=>new Promise(resolve=>{release=resolve;}))};
    let settled=false;const pending=speech.speak('测试').then(()=>{settled=true;});expect(speech.cloudApi.synthesizeSpeech).toHaveBeenCalled();speech.cancel();await Promise.resolve();
    expect(settled).toBe(true);release({audioBase64:'YWJj',mimeType:'audio/mpeg'});await pending;expect(speech.isSpeaking()).toBe(false);
  });
});


describe('Tencent audio outcomes',()=>{
  it('plays returned cloud audio and resolves when playback ends',async()=>{
    const {speech,audios,utterances}=engine();speech.cloudSettings={provider:'tencent',fallbackToLocal:false};speech.cloudApi={synthesizeSpeech:vi.fn().mockResolvedValue({audioBase64:'YWJj',mimeType:'audio/mpeg'})};
    const pending=speech.speak('你好');await vi.waitFor(()=>expect(audios).toHaveLength(1));expect(audios[0].src).toBe('data:audio/mpeg;base64,YWJj');audios[0].onended();expect(await pending).toBe(true);expect(speech.isSpeaking()).toBe(false);expect(utterances).toHaveLength(0);
  });
  it('falls back to local speech when configured and cloud synthesis fails',async()=>{
    const {speech,utterances,window}=engine();speech.cloudSettings={provider:'tencent',fallbackToLocal:true};speech.cloudApi={synthesizeSpeech:vi.fn().mockRejectedValue(new Error('cloud unavailable'))};
    const pending=speech.speak('你好');await vi.waitFor(()=>expect(window.dispatchEvent).toHaveBeenCalled());expect(utterances).toHaveLength(1);utterances[0]!.onend();expect(await pending).toBe(true);
  });
});

describe('Jarvis preview and summaries',()=>{
  it('allows preview while automatic replies are disabled',()=>{
    const {speech,utterances}=engine();speech.enabled=false;void speech.speak('试听',{preview:true});expect(utterances).toHaveLength(1);
  });
  it('does not cut a normal reply midway through a sentence',()=>{
    const {speech}=engine();speech.speak=vi.fn();const reply='第一句。'+ '这是完整的汇报内容，'.repeat(20)+'最后一句已经说完。';speech.speakSummary(reply);expect(speech.speak.mock.calls[0][0]).toContain('最后一句已经说完。');
  });
});


describe('playback echo identification',()=>{
  it('recognizes recent output fragments without treating a fresh wake word as output',()=>{
    const {speech}=engine();void speech.speak('先生，所有服务已经恢复正常，请放心。');
    expect(speech.matchesRecentSpeech('所有服务已经恢复正常，请放心。')).toBe(true);
    expect(speech.matchesRecentSpeech('贾维斯，帮我看屏幕')).toBe(false);
  });
});

describe('complete spoken replies', () => {
  it.each([131, 141, 1201, 3000])('preserves the complete %i-character response', (length) => {
    const {speech}=engine();speech.speak=vi.fn();
    const reply='完整内容'.repeat(Math.ceil(length/4)).slice(0,length)+'。最后一句不能丢失。';
    speech.speakSummary(reply);
    expect(speech.speak).toHaveBeenCalledWith(`先生，${reply}`);
  });
  it('sends all text to Tencent in bounded chunks and completes only after the final chunk', async () => {
    const {speech,audios}=engine();
    speech.cloudSettings={provider:'tencent',fallbackToLocal:false};
    const synthesizeSpeech=vi.fn().mockResolvedValue({audioBase64:'YWJj',mimeType:'audio/mpeg'});
    speech.cloudApi={synthesizeSpeech};
    const reply='请完整播报这一段内容。'.repeat(120)+'这是最终结尾。';
    const expected=`先生，${reply}`;
    let completed: boolean | undefined;
    const playback=speech.speakSummary(reply).then((result:boolean)=>{completed=result;return result;});
    for(let i=0;i<Math.ceil(Array.from(expected).length/140);i++){
      await vi.waitFor(()=>expect(audios.length>i || completed!==undefined).toBe(true),{interval:5});
      if(completed!==undefined) break;
      audios[i].onended();
    }
    expect(await playback).toBe(true);
    const chunks=synthesizeSpeech.mock.calls.map(call=>call[0] as string);
    expect(chunks.every(chunk=>Array.from(chunk).length<=140)).toBe(true);
    expect(chunks.join('')).toBe(expected);
    expect(speech.isSpeaking()).toBe(false);
  });
});

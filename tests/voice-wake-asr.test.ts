import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect,vi} from 'vitest';

function setup(provider='tencent',duration=0.001) {
  const close=vi.fn().mockResolvedValue(undefined);
  const hap={getSpeechSettings:async()=>({asrProvider:provider}),transcribeAudio:vi.fn().mockResolvedValue({ok:true,text:'你好'})};
  class AudioContext {
    close=close;
    async decodeAudioData(){return {duration,length:16};}
  }
  class OfflineAudioContext {
    destination={};
    createBufferSource(){return {buffer:null,connect(){},start(){}};}
    async startRendering(){return {getChannelData:()=>new Float32Array([-1,0,1])};}
  }
  const window:any={hap,AudioContext,OfflineAudioContext};
  runInNewContext(readFileSync(new URL('../src/gui/renderer/voice-wake.js',import.meta.url),'utf8'),{window,setTimeout:()=>0,console,Blob});
  const controller=window.voiceWakeController;
  controller._blobToBase64=async(blob:Blob)=>Buffer.from(await blob.arrayBuffer()).toString('base64');
  return {controller,close,hap};
}

describe('voice recording ASR integration',()=>{
  it('converts recorder audio to mono PCM16 WAV and releases decoder',async()=>{
    const {controller,close}=setup();
    const payload=await controller._audioPayload(new Blob(['webm'],{type:'audio/webm'}));
    const wav=Buffer.from(payload.audioBase64,'base64');
    expect(payload.mimeType).toBe('audio/wav');
    expect(wav.toString('ascii',0,4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1);expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readInt16LE(44)).toBe(-32768);expect(wav.readInt16LE(48)).toBe(32767);
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects recordings longer than 60 seconds and still closes decoder',async()=>{
    const {controller,close}=setup('tencent',61);
    await expect(controller._audioPayload(new Blob(['audio']))).rejects.toThrow('60');
    expect(close).toHaveBeenCalledOnce();
  });
  it('preserves the generic model path and actually submits recorded audio',async()=>{
    const {controller,hap}=setup('model');controller._handleTranscribedText=vi.fn();
    await controller._processAudioChunk(new Blob(['audio'],{type:'audio/webm'}));
    expect(hap.transcribeAudio).toHaveBeenCalledWith({audioBase64:Buffer.from('audio').toString('base64'),mimeType:'audio/webm'});
    expect(controller._handleTranscribedText).toHaveBeenCalledWith('你好',false);
  });
  it('submits manual recordings through the same preparation path',async()=>{
    const {controller,hap}=setup('model');controller.executeCommand=vi.fn();
    controller.isManualRecording=true;controller.recordedChunks=[new Blob(['manual'])];
    controller.mediaRecorder={mimeType:'audio/webm',stop(){void this.onstop();},onstop:async()=>{}};
    expect(await controller.stopManualRecordingAndTranscribe()).toBe('你好');
    expect(hap.transcribeAudio).toHaveBeenCalledWith({audioBase64:Buffer.from('manual').toString('base64'),mimeType:'audio/webm'});
  });
});

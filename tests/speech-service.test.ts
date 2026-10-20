import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {SpeechService} from '../src/gui/speech-service.js';
const services: string[]=[];
function service(){const dir=mkdtempSync(join(tmpdir(),'hap-speech-'));services.push(dir);return {dir,svc:new SpeechService(dir)};}
afterEach(()=>{vi.unstubAllGlobals();for(const dir of services.splice(0)) rmSync(dir,{recursive:true,force:true});});
describe('Tencent speech settings and synthesis',()=>{
  it('retains blank secrets and returns only credential status',()=>{
    const {svc,dir}=service();svc.saveSettings({provider:'tencent',secretId:'test-id',secretKey:'test-secret',voiceType:1001});
    const result=svc.saveSettings({secretId:'',secretKey:'',speed:1});
    expect(result.credentialsConfigured).toBe(true);expect(JSON.stringify(result)).not.toContain('test-secret');expect(JSON.stringify(result)).not.toContain('test-id');
    expect(readFileSync(join(dir,'speech.json'),'utf8')).toContain('test-secret');expect(statSync(join(dir,'speech.json')).mode&0o777).toBe(0o600);
  });
  it('rejects invalid options without replacing saved settings',()=>{
    const {svc}=service();expect(()=>svc.saveSettings({speed:7})).toThrow();expect(()=>svc.saveSettings({voiceType:-1})).toThrow();expect(()=>svc.saveSettings({provider:'invalid' as 'local'})).toThrow();expect(svc.getSettings().provider).toBe('local');
  });
  it('signs TextToVoice with the saved options and returns audio',async()=>{
    const {svc}=service();svc.saveSettings({provider:'tencent',secretId:'test-id',secretKey:'test-secret',voiceType:1001,region:'ap-guangzhou',speed:0.5});
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({Response:{Audio:'YWJj',RequestId:'req'}})});vi.stubGlobal('fetch',fetchMock);
    expect(await svc.synthesize('你好')).toEqual({audioBase64:'YWJj',mimeType:'audio/mpeg'});
    const [url,request]=fetchMock.mock.calls[0]!;expect(url).toBe('https://tts.tencentcloudapi.com/');expect(request.headers.Authorization).toContain('TC3-HMAC-SHA256 Credential=test-id/');expect(request.headers['X-TC-Action']).toBe('TextToVoice');
    expect(JSON.parse(request.body)).toMatchObject({Text:'你好',VoiceType:1001,Speed:0.5,Codec:'mp3'});expect(request.body).not.toContain('test-secret');
  });
  it('reports missing credentials and API errors, rejecting overlong input before calling',async()=>{
    const {svc}=service();await expect(svc.synthesize('你好')).rejects.toThrow();svc.saveSettings({provider:'tencent',secretId:'id',secretKey:'secret'});
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({Response:{Error:{Code:'UnsupportedOperation.ServerNotOpen',Message:'service unavailable'}}})});vi.stubGlobal('fetch',fetchMock);
    await expect(svc.synthesize('你好')).rejects.toThrow('UnsupportedOperation.ServerNotOpen');await expect(svc.synthesize('你'.repeat(151))).rejects.toThrow();expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Tencent transcription', () => {
  it('signs ASR requests and reports recognized text', async () => {
    const {svc}=service();
    svc.saveSettings({asrProvider:'tencent',asrEngine:'16k_zh',secretId:'id',secretKey:'secret'});
    const mock=vi.fn().mockResolvedValue({ok:true,json:async()=>({Response:{Result:'你好，贾维斯。'}})});
    vi.stubGlobal('fetch',mock);
    expect(await svc.transcribe({audioBase64:'YWJj',mimeType:'audio/mpeg'})).toEqual({ok:true,text:'你好，贾维斯。'});
    const [url,req]=mock.mock.calls[0]!;
    expect(url).toBe('https://asr.tencentcloudapi.com/');
    expect(req.headers['X-TC-Action']).toBe('SentenceRecognition');
    expect(req.headers.Authorization).toContain('/asr/tc3_request');
    expect(JSON.parse(req.body)).toMatchObject({EngSerViceType:'16k_zh',VoiceFormat:'mp3',DataLen:3,SourceType:1});
  });
  it('rejects unsupported formats and oversized or malformed audio before sending',async()=>{
    const {svc}=service();const mock=vi.fn();vi.stubGlobal('fetch',mock);
    await expect(svc.transcribe({audioBase64:'YWJj',mimeType:'audio/webm'})).rejects.toThrow();
    await expect(svc.transcribe({audioBase64:'?',mimeType:'audio/wav'})).rejects.toThrow();
    await expect(svc.transcribe({audioBase64:'A'.repeat(3*1024*1024+4),mimeType:'audio/wav'})).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    expect(()=>svc.saveSettings({asrEngine:'bad' as '16k_zh'})).toThrow();
  });
});

describe('expressive Tencent voices',()=>{
  it('saves and sends supported emotion controls with the selected male voice',async()=>{
    const {svc}=service();svc.saveSettings({provider:'tencent',secretId:'id',secretKey:'secret',voiceType:601008,emotionCategory:'peaceful',emotionIntensity:90});
    const mock=vi.fn().mockResolvedValue({ok:true,json:async()=>({Response:{Audio:'YWJj'}})});vi.stubGlobal('fetch',mock);
    await svc.synthesize('先生，我在这里，请放心。');
    expect(JSON.parse(mock.mock.calls[0]![1].body)).toMatchObject({VoiceType:601008,EmotionCategory:'peaceful',EmotionIntensity:90});
    expect(svc.getSettings()).toMatchObject({emotionCategory:'peaceful',emotionIntensity:90});
  });
  it('rejects out-of-range intensity and unsupported emotion names',()=>{
    const {svc}=service();expect(()=>svc.saveSettings({emotionIntensity:300})).toThrow();expect(()=>svc.saveSettings({emotionCategory:'made-up' as 'peaceful'})).toThrow();
  });
});

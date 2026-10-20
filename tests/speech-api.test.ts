import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect,vi} from 'vitest';
import {createWebApp} from '../src/web/server.js';

describe('speech API',()=>{
  it('protects credentials and persists public settings across requests',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'hap-speech-api-'));vi.stubEnv('HAP_GUI_DATA_DIR',dir);
    try {
      const app=createWebApp({auth:'speech-test-token',configPath:join(dir,'config.toml')});
      expect((await app.request('/api/speech/settings')).status).toBe(401);
      const headers={'Content-Type':'application/json',Authorization:'Bearer speech-test-token'};
      const saved=await app.request('/api/speech/settings',{method:'POST',headers,body:JSON.stringify({provider:'tencent',asrProvider:'tencent',secretId:'fake-id',secretKey:'fake-secret',voiceType:1001})});
      expect(saved.status).toBe(200);expect(await saved.text()).not.toContain('fake-secret');
      const read=await app.request('/api/speech/settings',{headers});expect((await read.json()).data).toMatchObject({provider:'tencent',credentialsConfigured:true});
      const invalid=await app.request('/api/speech/settings',{method:'POST',headers,body:JSON.stringify({speed:999})});expect(invalid.status).toBe(400);
      expect((await app.request('/api/speech/transcribe',{method:'POST'})).status).toBe(401);
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({Response:{Result:'你好'}})}));
      const recognized=await app.request('/api/speech/transcribe',{method:'POST',headers,body:JSON.stringify({audioBase64:'YWJj',mimeType:'audio/mpeg'})});
      expect(await recognized.json()).toEqual({ok:true,text:'你好'});
      const synth=await app.request('/api/speech/synthesize',{method:'POST',headers,body:JSON.stringify({text:''})});expect(synth.status).toBe(400);
    } finally {vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
  });
});

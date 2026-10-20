import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
const source = readFileSync('src/gui/renderer/app.js', 'utf8');
function submitHarness(failModel = false) {
  let submit: (e: unknown) => Promise<void> = async () => {};
  const close = vi.fn();
  const hap = { upsertProvider: vi.fn().mockResolvedValue({ok:true}), batchRemoveModels: vi.fn().mockResolvedValue({ok:true}), upsertModel: failModel ? vi.fn().mockRejectedValue(new Error('invalid model')) : vi.fn().mockResolvedValue({ok:true}) };
  const showToast = vi.fn();
  const model = {alias:'voice',model:'voice',category:'audio',capabilities:['audio'],contextWindow:4096,maxOutputTokens:300,protocol:'openai-tools'};
  const nodes: Record<string, unknown> = {providerForm:{addEventListener: (_:string, fn:typeof submit) => {submit=fn;}},providerDialog:{close}};
  const context = {window:{hap,switchProviderModelView:vi.fn()},$: (id:string)=>nodes[id],FormData: class { *[Symbol.iterator]() {yield ['id','test'];yield ['baseUrl','https://example.com/v1'];yield ['wireApi','chat'];yield ['protocol','openai-tools'];} },currentDialogModels:[model],originalDialogModelAliases:new Set(),showToast,refresh:vi.fn(),inferDefaultContextWindow:()=>4096,console, resetProviderModelFilters:vi.fn()};
  runInNewContext(source.slice(source.indexOf("$('providerForm')?.addEventListener('submit'"),source.indexOf('window.deleteProvider =')),context);
  return { submit:()=>submit({preventDefault(){},currentTarget:{}}),hap,close,showToast,model };
}
describe('provider dialog saves',()=>{
  it('keeps the dialog open and reports a failed model write',async()=>{
    const h=submitHarness(true);await h.submit();expect(h.close).not.toHaveBeenCalled();expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining('invalid model'),'error');
  });
  it('preserves existing model capabilities and generation settings',async()=>{
    const h=submitHarness();await h.submit();expect(h.hap.upsertModel).toHaveBeenCalledWith(expect.objectContaining({capabilities:['audio'],maxOutputTokens:300,protocol:'openai-tools'}));
  });
});

describe('remote model aliases', () => {
  it('keeps different upstream namespaces and providers from overwriting the same alias', () => {
    const models: unknown[] = [];
    const context = {window:{} as Record<string, unknown>,state:{models:[{alias:'shared',providerId:'other',model:'shared'}]},currentDialogModels:models,$:()=>({value:'new'}),renderCurrentDialogModels:vi.fn(),showToast:vi.fn(),inferDefaultContextWindow:()=>4096};
    const start=source.indexOf('function uniqueDialogModelAlias');
    const end=source.indexOf('// 手动添加模型条',source.indexOf('window.addModelToDialogFromRemote ='));
    expect(start).toBeGreaterThan(-1);
    runInNewContext(source.slice(start,end),context);
    const add=context.window.addModelToDialogFromRemote as (name:string)=>void;
    add('org-a/shared');add('org-b/shared');add('org-b/shared');
    expect(models).toHaveLength(2);
    const aliases=models.map(m=>(m as {alias:string}).alias);
    expect(new Set(aliases).size).toBe(2);expect(aliases).not.toContain('shared');
  });
});

describe('quick model import',()=>{
  function harness(fail=false){
    const button: {disabled:boolean;onclick?:()=>Promise<void>}={disabled:false};
    const close=vi.fn();const showToast=vi.fn();const upsertModel=fail?vi.fn().mockRejectedValue(new Error('write failed')):vi.fn().mockResolvedValue({ok:true});
    const context={window:{hap:{upsertModel}},$:()=>button,listEl:{querySelectorAll:()=>[{dataset:{model:'org/shared'}},{dataset:{model:'org-b/shared'}}]},state:{models:[{alias:'shared',providerId:'other',model:'org/shared'}]},currentDialogModels:[],providerId:'new',dialog:{close},showToast,isVisionName:()=>false,inferDefaultContextWindow:()=>4096,resetProviderModelFilters:vi.fn(),refresh:vi.fn()};
    const helper=source.slice(source.indexOf('function uniqueDialogModelAlias'),source.indexOf('window.addModelToDialogFromRemote ='));
    const begin=source.indexOf("    $('confirmQuickModelSyncBtn').onclick =");
    runInNewContext(helper+source.slice(begin,source.indexOf("    $('closeQuickModelSyncBtn')",begin)),context);
    return {button,close,showToast,upsertModel};
  }
  it('does not overwrite another provider or namespace during batch imports',async()=>{
    const h=harness();await h.button.onclick!();const aliases=h.upsertModel.mock.calls.map(c=>c[0].alias);expect(new Set(aliases).size).toBe(2);expect(aliases).not.toContain('shared');expect(h.close).toHaveBeenCalled();
  });
  it('keeps the import dialog available and reports failed writes',async()=>{
    const h=harness(true);await h.button.onclick!();expect(h.close).not.toHaveBeenCalled();expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining('write failed'),'error');expect(h.button.disabled).toBe(false);
  });
});

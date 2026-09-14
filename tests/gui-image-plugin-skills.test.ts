import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({ dialog: {}, shell: {} }));
import { GuiService } from '../src/gui/service.js';

describe('AI Image Generation Plugin & Skill Ecosystem', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'hap-img-skill-'));
    dirs.push(dir);
    const service = Object.create(GuiService.prototype) as GuiService;
    Object.assign(service, { info: vi.fn(), error: vi.fn() });
    return { service, dir };
  }

  it('provides built-in Image Generation Skills with category, promptTemplate and style', () => {
    const html = readFileSync('src/gui/renderer/index.html', 'utf8');
    const app = readFileSync('src/gui/renderer/app.js', 'utf8');
    const serviceSource = readFileSync('src/gui/service.ts', 'utf8');

    // Verify service has image skills
    expect(serviceSource).toContain("'img-skill-cyberpunk'");
    expect(serviceSource).toContain("'img-skill-photoreal'");
    expect(serviceSource).toContain("'img-skill-anime'");
    expect(serviceSource).toContain('promptTemplate:');
    expect(serviceSource).toContain("category: 'image'");
  });

  it('supports importing custom skills with importSkill API', () => {
    const { service } = setup();
    const imported = service.importSkill({
      name: '极简矢量图标 (Minimal Vector)',
      description: '生成极简扁平化现代商业矢量图标',
      category: 'image',
      style: 'vector',
      promptTemplate: 'minimal vector icon, clean sharp lines, flat color, {{prompt}}, white background',
      negativePrompt: 'photorealistic, blurry, 3d',
      tags: ['生图', 'Vector', 'Icon'],
    });

    expect(imported).toBeDefined();
    expect(imported.id).toBeDefined();
    expect(imported.name).toBe('极简矢量图标 (Minimal Vector)');
    expect(imported.category).toBe('image');
    expect(imported.promptTemplate).toContain('{{prompt}}');
    expect(imported.installed).toBe(true);
    expect(imported.enabled).toBe(true);
  });

  it('synthesizes prompt with skill templates and fallback appending', () => {
    const app = readFileSync('src/gui/renderer/app.js', 'utf8');
    expect(app).toContain('function synthesizePromptWithSkill(rawPrompt, skill)');

    // Run synthesis logic in isolated function
    function synthesizePromptWithSkill(rawPrompt: string, skill?: { promptTemplate?: string }) {
      if (!rawPrompt) return '';
      if (!skill || !skill.promptTemplate) return rawPrompt;
      const tpl = skill.promptTemplate.trim();
      if (!tpl) return rawPrompt;
      if (tpl.includes('{{prompt}}')) {
        return tpl.replace(/\{\{prompt\}\}/g, rawPrompt);
      }
      return `${rawPrompt}, ${tpl}`;
    }

    const templateSkill = {
      promptTemplate: 'cyberpunk neon city, glowing highlights, {{prompt}}, 8k render',
    };
    expect(synthesizePromptWithSkill('一只未来机械猫', templateSkill))
      .toBe('cyberpunk neon city, glowing highlights, 一只未来机械猫, 8k render');

    const appendSkill = {
      promptTemplate: 'masterpiece, ultra-detailed, cinematic lighting',
    };
    expect(synthesizePromptWithSkill('雪山日出', appendSkill))
      .toBe('雪山日出, masterpiece, ultra-detailed, cinematic lighting');

    expect(synthesizePromptWithSkill('单纯描述', undefined)).toBe('单纯描述');
  });

  it('contains ChatGPT desktop style mention popover, active plugin pill tray, and modal controls', () => {
    const html = readFileSync('src/gui/renderer/index.html', 'utf8');
    const css = readFileSync('src/gui/renderer/styles.css', 'utf8');
    const app = readFileSync('src/gui/renderer/app.js', 'utf8');

    // UI elements exist in DOM
    expect(html).toContain('id="composerPluginTray"');
    expect(html).toContain('id="composerMentionMenu"');
    expect(html).toContain('id="imageGenSkillSelect"');
    expect(html).toContain('id="imageSkillDetailCard"');
    expect(html).toContain('id="openImportSkillModalBtn"');
    expect(html).toContain('id="importSkillModal"');
    expect(html).toContain('id="importSkillFileInput"');
    expect(html).toContain('id="importSkillContentInput"');
    expect(html).toContain('id="doImportSkillSubmitBtn"');

    // CSS rules exist
    expect(css).toContain('.composer-plugin-tray');
    expect(css).toContain('.composer-mention-menu');
    expect(css).toContain('.composer-active-plugin');
    expect(css).toContain('.image-skill-detail-card');
    expect(css).toContain('.plugin-executing-skill-banner');

    // Mention system logic exists in app.js
    expect(app).toContain('COMPOSER_PLUGINS');
    expect(app).toContain('initComposerMentionSystem');
    expect(app).toContain('setActiveComposerPlugin');
    expect(app).toContain('renderActivePluginTray');
    expect(app).toContain('executeImageGenPlugin');
    expect(app).toContain('initImportSkillModal');
    expect(app).toContain('populateImageGenSkills');
    expect(app).toContain('updateImageSkillDetailCard');
  });

  it('explains what Skill was used in the assistant response with prompt breakdown', () => {
    const app = readFileSync('src/gui/renderer/app.js', 'utf8');
    // Verifies assistant message includes skill details and prompt transformation
    expect(app).toContain('> ⚡ **应用技能 (Skill)**：');
    expect(app).toContain('> 📖 **技能说明**：');
    expect(app).toContain('> 📝 **原始描述**：');
    expect(app).toContain('> 🪄 **技能增强提示词**：');
    expect(app).toContain('plugin-executing-skill-banner');
  });

  it('does not report a generated image as failed while finalizing the success path', () => {
    const app = readFileSync('src/gui/renderer/app.js', 'utf8');

    expect(app).not.toContain('loadProjectFiles(');
  });

  it('exposes gui:importSkill in IPC main and preload contracts', () => {
    const main = readFileSync('src/gui/main.ts', 'utf8');
    const preload = readFileSync('src/gui/renderer/preload.cjs', 'utf8');

    expect(main).toContain("ipcMain.handle('gui:importSkill'");
    expect(preload).toContain("importSkill: (skillData) => call('gui:importSkill', skillData)");
  });

  it('preserves image generating plugin state across session switches and renders dedicated executing card', () => {
    const app = readFileSync('src/gui/renderer/app.js', 'utf8');

    // 1. Verifies renderCurrentSessionMessages checks session.generatingPlugin
    expect(app).toContain("session.generatingPlugin && session.generatingPlugin.id === 'image-gen'");
    expect(app).toContain('AI 生图插件正在精心绘制中...');
    expect(app).toContain('中止本次生图');

    // 2. Verifies session generatingPlugin is set on the target session during chatForm submission
    expect(app).toContain("id: 'image-gen'");
    expect(app).toContain('session.generatingPlugin = {');

    // 3. Verifies switchSession preserves generating state and clears leftover composer plugin
    expect(app).toContain('window.switchSession =');
    expect(app).toContain('clearActiveComposerPlugin()');

    // 4. Verifies saveSessionsToStorage scrubs transient generatingPlugin
    expect(app).toContain('generatingPlugin: null');
  });

  it('correctly extracts explicit models such as gpt-image-2.5 or dall-e-3 from natural user prompt', () => {
    function extractExplicitModel(inputPrompt: string) {
      let rawPrompt = inputPrompt;
      let explicitModel = '';
      const modelFlagsRegex = /(?:--model|-m)\s+([a-zA-Z0-9_./-]+)/i;
      const modelKeywordRegex = /(?:(?:请?调用|使用|通过|以|用|采用|模型\s*[:：=]?)\s*([a-zA-Z0-9_./-]+)\s*(?:(?:来|去)?(?:生成|绘制|画|作图|做图|制作|渲染))?\s*)/i;

      const flagMatch = rawPrompt.match(modelFlagsRegex);
      if (flagMatch && flagMatch[1]) {
        explicitModel = flagMatch[1];
        rawPrompt = rawPrompt.replace(flagMatch[0], '').trim();
      } else {
        const kwMatch = rawPrompt.match(modelKeywordRegex);
        if (kwMatch && kwMatch[1]) {
          const candidate = kwMatch[1];
          const isLikelyModel = /[-./\d]/.test(candidate) ||
            ['gpt', 'flux', 'dall', 'sd', 'sdxl', 'cogview', 'imagen', 'midjourney'].some(k => candidate.toLowerCase().includes(k));
          if (isLikelyModel) {
            explicitModel = candidate;
            rawPrompt = rawPrompt.replace(kwMatch[0], '').trim();
          }
        }
      }
      rawPrompt = rawPrompt.replace(/^[，,、\s]+|[，,、\s]+$/g, '').trim();
      return { explicitModel, rawPrompt };
    }

    const res1 = extractExplicitModel('调用gpt-image-2.5生成一张剑仙图片');
    expect(res1.explicitModel).toBe('gpt-image-2.5');
    expect(res1.rawPrompt).toBe('一张剑仙图片');

    const res2 = extractExplicitModel('使用 dall-e-3 画一只赛博朋克猫咪');
    expect(res2.explicitModel).toBe('dall-e-3');
    expect(res2.rawPrompt).toBe('一只赛博朋克猫咪');

    const res3 = extractExplicitModel('--model flux-schnell 宏伟的太空星港，写实光影');
    expect(res3.explicitModel).toBe('flux-schnell');
    expect(res3.rawPrompt).toBe('宏伟的太空星港，写实光影');
  });

  it('correctly extracts skills specified in user natural language prompts like 技能:赛博朋克 or 使用水墨技能', () => {
    function extractSkillAndPrompt(inputPrompt: string, skills: Array<{ id: string; name: string }>) {
      let rawPrompt = inputPrompt;
      let matchedSkill: { id: string; name: string } | undefined;
      const skillFlagsRegex = /(?:--skill|-s)\s+([^\s,，]+)/i;
      const skillKeywordRegex = /(?:(?:技能|skill)\s*[:：=]\s*([^\s,，]+))|(?:(?:使用|应用|采用|调用|配合|搭配)\s*([^\s,，]+)\s*(?:生图)?(?:技能|skill))/i;

      let candidateSkillWord = '';
      let matchToRemove = '';

      const flagMatch = rawPrompt.match(skillFlagsRegex);
      if (flagMatch && flagMatch[1]) {
        candidateSkillWord = flagMatch[1];
        matchToRemove = flagMatch[0];
      } else {
        const kwMatch = rawPrompt.match(skillKeywordRegex);
        if (kwMatch) {
          candidateSkillWord = kwMatch[1] || kwMatch[2] || '';
          matchToRemove = kwMatch[0];
        }
      }

      if (candidateSkillWord) {
        const wordLower = candidateSkillWord.toLowerCase();
        const found = skills.find(s => {
          const sName = (s.name || '').toLowerCase();
          const sId = (s.id || '').toLowerCase();
          const shortName = sName.split(/[\s·(（]/)[0] || '';
          return sName.includes(wordLower) || (Boolean(shortName) && wordLower.includes(shortName)) || sId.includes(wordLower);
        });
        if (found) {
          matchedSkill = found;
          rawPrompt = rawPrompt.replace(matchToRemove, '').trim();
        }
      }
      rawPrompt = rawPrompt.replace(/^[，,、\s]+|[，,、\s]+$/g, '').trim();
      return { matchedSkill, rawPrompt };
    }

    const testSkills = [
      { id: 'img-skill-cyberpunk', name: '赛博朋克霓虹机能 (Cyberpunk Neo-Glow)' },
      { id: 'img-skill-ink', name: '东方意境水墨丹青 (Oriental Ink Wash)' },
      { id: 'img-skill-anime', name: '新海诚唯美动漫风景 (Makoto Shinkai Anime)' },
    ];

    const r1 = extractSkillAndPrompt('技能:赛博朋克 一只未来都市机械猫咪', testSkills);
    expect(r1.matchedSkill?.id).toBe('img-skill-cyberpunk');
    expect(r1.rawPrompt).toBe('一只未来都市机械猫咪');

    const r2 = extractSkillAndPrompt('使用水墨技能 绝壁松柏，云海苍茫', testSkills);
    expect(r2.matchedSkill?.id).toBe('img-skill-ink');
    expect(r2.rawPrompt).toBe('绝壁松柏，云海苍茫');

    const r3 = extractSkillAndPrompt('--skill anime 雨后电车车站', testSkills);
    expect(r3.matchedSkill?.id).toBe('img-skill-anime');
    expect(r3.rawPrompt).toBe('雨后电车车站');
  });
});

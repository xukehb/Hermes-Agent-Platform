import { describe, it, expect } from 'vitest';
import { WeChatVoiceTranscriber } from '../src/channels/wechat/voice-transcriber.js';
import { WeChatApprovalManager } from '../src/channels/wechat/approval-card.js';

describe('WeChat Voice Ingress & Approval Manager', () => {
  describe('Voice Transcriber', () => {
    it('handles empty audio gracefully', async () => {
      const transcriber = new WeChatVoiceTranscriber();
      const res = await transcriber.transcribe(Buffer.alloc(0));
      expect(res).toBe('');
    });

    it('formats voice prompts with identification emoji', () => {
      const transcriber = new WeChatVoiceTranscriber();
      const prompt = transcriber.formatVoicePrompt('帮我部署前端页面');
      expect(prompt).toContain('🎙️ [微信语音识别指令]');
      expect(prompt).toContain('帮我部署前端页面');
    });
  });

  describe('Approval State Machine', () => {
    const manager = WeChatApprovalManager.getInstance();

    it('creates approval, intercepts commands, and resolves upon user reply 1 (approve)', async () => {
      const { promptText, waitPromise } = await manager.requestApproval({
        userId: 'wx_user_1',
        agent: 'ops',
        action: 'rm -rf /tmp/cache',
        reason: '清理临时缓存文件',
      });

      expect(promptText).toContain('【智能体高危操作审批请求】');
      expect(promptText).toContain('rm -rf /tmp/cache');
      expect(manager.hasPendingApproval('wx_user_1')).toBe(true);

      // 模拟用户回复 "1" 或 "同意"
      const replyRes = manager.handleUserReply('wx_user_1', '1');
      expect(replyRes.handled).toBe(true);
      expect(replyRes.approved).toBe(true);

      const approved = await waitPromise;
      expect(approved).toBe(true);
      expect(manager.hasPendingApproval('wx_user_1')).toBe(false);
    });

    it('resolves false upon user reply 2 (reject)', async () => {
      const { waitPromise } = await manager.requestApproval({
        userId: 'wx_user_2',
        agent: 'coder',
        action: 'git push --force origin main',
      });

      const replyRes = manager.handleUserReply('wx_user_2', '拒绝');
      expect(replyRes.handled).toBe(true);
      expect(replyRes.approved).toBe(false);

      const approved = await waitPromise;
      expect(approved).toBe(false);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isCronMatch, describeCron } from '../src/scheduler/cron-parser.js';
import { ScheduleStore } from '../src/scheduler/storage.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Scheduler Module & Cron Parser', () => {
  describe('Cron Parser Matcher', () => {
    it('matches exact minute and hour', () => {
      const d = new Date(2026, 7, 28, 9, 30, 0); // 2026-08-28 09:30 (Friday)
      expect(isCronMatch('30 9 * * *', d)).toBe(true);
      expect(isCronMatch('0 9 * * *', d)).toBe(false);
      expect(isCronMatch('30 10 * * *', d)).toBe(false);
    });

    it('matches step values like */5 and */15', () => {
      const d1 = new Date(2026, 7, 28, 14, 15, 0);
      expect(isCronMatch('*/5 * * * *', d1)).toBe(true);
      expect(isCronMatch('*/15 * * * *', d1)).toBe(true);
      expect(isCronMatch('*/10 * * * *', d1)).toBe(false);
    });

    it('matches day of week and lists', () => {
      const friday = new Date(2026, 7, 28, 10, 0, 0); // Friday = day 5
      expect(isCronMatch('0 10 * * 1-5', friday)).toBe(true);
      expect(isCronMatch('0 10 * * 0,6', friday)).toBe(false);
    });

    it('generates friendly Chinese descriptions', () => {
      expect(describeCron('*/15 * * * *')).toContain('每隔 15 分钟');
      expect(describeCron('0 9 * * *')).toContain('每天 09:00');
      expect(describeCron('30 18 * * 1-5')).toContain('工作日');
    });
  });

  describe('Schedule Store', () => {
    const testFile = join(tmpdir(), `test-schedules-${Date.now()}.json`);
    let store: ScheduleStore;

    beforeEach(() => {
      store = ScheduleStore.getInstance(testFile);
    });

    afterEach(() => {
      if (existsSync(testFile)) {
        try { unlinkSync(testFile); } catch {}
      }
    });

    it('creates, lists, toggles and removes jobs', () => {
      const job = store.upsertJob({
        name: '测试每日代码审查',
        cron: '0 9 * * 1-5',
        agent: 'reviewer',
        prompt: '检查昨日提交',
        notifyChannels: ['wechat', 'logs'],
      });

      expect(job.id).toBeDefined();
      expect(job.name).toBe('测试每日代码审查');
      expect(job.enabled).toBe(true);

      const list = store.listJobs();
      expect(list.some(j => j.id === job.id)).toBe(true);

      const toggled = store.toggleJob(job.id, false);
      expect(toggled?.enabled).toBe(false);

      const removed = store.removeJob(job.id);
      expect(removed).toBe(true);
      expect(store.getJob(job.id)).toBeUndefined();
    });

    it('records execution history correctly', () => {
      const record = store.recordExecution({
        scheduleId: 'test-sched-1',
        scheduleName: '测试任务',
        agent: 'coder',
        prompt: '运行测试',
        startedAt: 1000,
        finishedAt: 2500,
        status: 'success',
        durationMs: 1500,
        output: '所有测试通过',
      });

      expect(record.id).toBeDefined();
      expect(record.status).toBe('success');
      const history = store.getHistory('test-sched-1');
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0]?.output).toBe('所有测试通过');
    });
  });
});

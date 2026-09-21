import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOrchestrator } from '../src/agent/index.js';
import type { AgentMessage } from '../src/domain/index.js';
import type { ProviderFactory } from '../src/providers/index.js';
import { MockProviderClient, textTurn } from '../src/providers/mock.js';

describe('Conversation Continuity & History Preservation', () => {
  it('preserves multi-turn conversation history passed via request.history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hap-continuity-'));
    try {
      const configPath = join(root, 'hap.toml');
      const configContent = `
default_agent = 'alpha'
default_model = 'mockp/model-a'

[paths]
data_dir = '${join(root, 'data')}'

[model_providers.mockp]
name = 'Mock'
base_url = 'http://127.0.0.1:9/v1'
wire_api = 'chat'
default_protocol = 'openai-tools'

[models.model-a]
provider = 'mockp'
model = 'model-a'

[agents.defaults]
workspace_root = '${join(root, 'ws')}'
agent_dir_root = '${join(root, 'agents')}'

[agents.entries.alpha]
name = 'Alpha'
capabilities = ['coding']
model = 'mockp/model-a'
[agents.entries.alpha.tools]
profile = 'minimal'
`;
      writeFileSync(configPath, configContent, 'utf8');

      const mockClient = new MockProviderClient({ providerId: 'mockp' });
      mockClient.push(textTurn('I remember our conversation!'));

      const factory: ProviderFactory = () => mockClient;
      const orchestrator = new AgentOrchestrator({
        configPath,
        env: {},
        factory,
        memoryStore: true,
      });

      const previousHistory: AgentMessage[] = [
        { role: 'user', content: 'Hello, my secret code is 8848.' },
        { role: 'assistant', content: 'Received. Your secret code is 8848.' },
        { role: 'user', content: 'What is my favorite animal? It is a red panda.' },
        { role: 'assistant', content: 'Noted, your favorite animal is a red panda.' },
      ];

      const outcome = await orchestrator.runTask({
        agentId: 'alpha',
        input: 'Can you repeat my secret code and favorite animal?',
        history: previousHistory,
      });

      expect(outcome.status).toBe('done');
      expect(mockClient.requests.length).toBeGreaterThan(0);

      const sentMessages = mockClient.requests[0]!.messages as Array<{ role?: string; content?: string }>;
      expect(sentMessages.length).toBeGreaterThanOrEqual(5);

      const secretMsg = sentMessages.find((m) => m.content && m.content.includes('8848'));
      expect(secretMsg).toBeDefined();

      const animalMsg = sentMessages.find((m) => m.content && m.content.includes('red panda'));
      expect(animalMsg).toBeDefined();

      const latestMsg = sentMessages[sentMessages.length - 1];
      expect(latestMsg?.role).toBe('user');
      expect(latestMsg?.content).toContain('repeat my secret code');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { randomUUID } from 'node:crypto';
import { digestArgs } from '../domain/index.js';
import type { ControlExecutionContext } from './types.js';

export type ToolPolicyDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'approval_required'; reason: string };

export interface ToolPolicyContext {
  control?: ControlExecutionContext | undefined;
  approvedRequestId?: string | undefined;
  approvalStore?: {
    createApprovalRequest?(input: {
      id: string;
      bindingId: string;
      operatorId: string;
      requestId: string;
      commandKind: string;
      argsDigest: string;
      risk: string;
      expiresAt: string;
    }): void;
    consumeApproval(input: {
      id: string;
      bindingId: string;
      operatorId: string;
      requestId: string;
      commandKind: string;
      argsDigest: string;
      consumedAt: string;
    }): boolean;
  } | undefined;
}

const readOnlyTools = new Set([
  'read_file', 'list_dir', 'search', 'find_definition', 'find_references', 'list_symbols',
  'host_sysinfo', 'remote_sysinfo', 'remote_list_servers',
]);
const mutatingTools = new Set([
  'shell', 'write_file', 'apply_patch', 'open_external', 'http_fetch', 'spawn_subagent',
  'remote_exec', 'remote_upgrade_daemon', 'disk_cleanup', 'generate_image',
]);

function requiresMutationGuard(toolName: string): boolean {
  if (mutatingTools.has(toolName)) return true;
  // MCP tools are untrusted and may mutate arbitrary state.  Treat them as
  // mutating unless a future explicit capability declaration says otherwise.
  return toolName.includes('__');
}

export function evaluateToolPolicy(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolPolicyContext,
): ToolPolicyDecision {
  const control = context.control;
  if (control === undefined) return { decision: 'allow', reason: '非控制平面任务' };
  if (readOnlyTools.has(toolName) && !toolName.includes('__')) {
    return { decision: 'allow', reason: '只读工具' };
  }
  if (!requiresMutationGuard(toolName)) {
    return { decision: 'deny', reason: '未声明的控制平面工具默认拒绝' };
  }
  if (control.capabilityProfile === 'observe' || control.role === 'viewer') {
    return { decision: 'deny', reason: 'CONTROL_FORBIDDEN: 当前绑定或角色只允许观察' };
  }

  const approvalPolicy = control.approvalPolicy ?? 'none';
  if (approvalPolicy === 'none') return { decision: 'allow', reason: '绑定未要求审批' };

  const argsDigest = digestArgs(args);
  if (context.approvedRequestId !== undefined && context.approvalStore?.consumeApproval({
    id: context.approvedRequestId,
    bindingId: control.bindingId,
    operatorId: control.operatorId,
    requestId: control.requestId,
    commandKind: toolName,
    argsDigest,
    consumedAt: new Date().toISOString(),
  })) {
    return { decision: 'allow', reason: '已消费一次性审批' };
  }
  const approvalId = randomUUID();
  context.approvalStore?.createApprovalRequest?.({
    id: approvalId,
    bindingId: control.bindingId,
    operatorId: control.operatorId,
    requestId: control.requestId,
    commandKind: toolName,
    argsDigest,
    risk: approvalPolicy,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  return { decision: 'approval_required', reason: `APPROVAL_REQUIRED: 此工具需要一次性审批（${approvalId}）` };
}

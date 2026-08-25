/**
 * 通道层出口。
 *
 * 日期：2026-08-24  执行者：Codex
 */

export type {
  Channel,
  ChannelAttachments,
  ChannelHost,
  ChannelName,
  InboundMessage,
  OutboundTarget,
} from './types.js';
export { parseCommand, extractMention, type ChannelCommand, type MentionMatch } from './command-parser.js';
export { SessionQueue, type EnqueueResult, type SessionQueueOptions } from './queue.js';
export { OutboundSender, splitForChannel, type SpoolEntry } from './outbound.js';
export { TaskRenderer, type RenderOptions } from './normalizer.js';
export {
  ChannelDispatcher,
  HELP_TEXT,
  describeError,
  renderStatus,
  renderTrace,
  renderUsage,
  type DispatcherOptions,
} from './dispatcher.js';
export { parseBind, type BindAddress } from './bind.js';
export { TelegramChannel, describeAttachments, type AttachmentSpec, type TelegramChannelOptions } from './telegram.js';
export {
  WhatsAppChannel,
  type SocketFactory,
  type WhatsAppChannelOptions,
} from './whatsapp.js';
export { HttpChannel, type HttpChannelOptions } from './http.js';
export { CliChannel, type CliChannelOptions } from './cli.js';
export { ChannelManager, createChannelHost, type ChannelManagerOptions } from './manager.js';

import { z } from 'zod';

export class IlinkError extends Error {
  readonly code: string;
  readonly endpoint?: string;
  readonly status?: number;

  constructor(code: string, message: string, options: { endpoint?: string; status?: number } = {}) {
    super(message);
    this.name = 'IlinkError';
    this.code = code;
    if (options.endpoint !== undefined) this.endpoint = options.endpoint;
    if (options.status !== undefined) this.status = options.status;
  }

  static schema(label: string): IlinkError {
    return new IlinkError('ILINK_SCHEMA', 'ILINK_SCHEMA: invalid ' + label);
  }

  static http(endpoint: string, status: number): IlinkError {
    return new IlinkError('ILINK_HTTP', 'ILINK_HTTP: ' + endpoint + ' returned HTTP ' + String(status), { endpoint, status });
  }
}

export const qrCreationSchema = z.strictObject({
  qrcode: z.string().min(1),
  qrcode_img_content: z.string().min(1),
});

export interface IlinkQrCreation {
  qrcode: string;
  qrcodeImageContent: string;
}

export const qrStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('wait') }),
  z.strictObject({ status: z.literal('scaned') }),
  z.strictObject({ status: z.literal('expired') }),
  z.strictObject({ status: z.literal('need_verifycode') }),
  z.strictObject({ status: z.literal('verify_code_blocked') }),
  z.strictObject({ status: z.literal('binded_redirect') }),
  z.strictObject({ status: z.literal('scaned_but_redirect'), redirect_host: z.string().min(1) }),
  z.strictObject({
    status: z.literal('confirmed'),
    bot_token: z.string().min(1),
    ilink_bot_id: z.string().min(1),
    ilink_user_id: z.string().min(1).optional(),
    baseurl: z.string().url(),
  }),
]);
export type IlinkQrStatus = z.infer<typeof qrStatusSchema>;

const textItemSchema = z.strictObject({
  type: z.literal(1),
  text_item: z.strictObject({ text: z.string() }),
});

const messageSchema = z.object({
  seq: z.number().optional(),
  message_id: z.union([z.string(), z.number()]).optional(),
  from_user_id: z.string().optional(),
  to_user_id: z.string().optional(),
  client_id: z.string().optional(),
  create_time_ms: z.number().optional(),
  session_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: z.number().optional(),
  message_state: z.number().optional(),
  context_token: z.string().optional(),
  item_list: z.array(textItemSchema).optional(),
});

export interface IlinkInboundMessage {
  id: string;
  fromUserId: string;
  toUserId?: string;
  sessionId?: string;
  groupId?: string;
  createdAt: string;
  contextToken?: string;
  text: string;
}

export interface IlinkUpdateBatch {
  ret: number;
  errcode?: number;
  errmsg?: string;
  cursor: string;
  longpollingTimeoutMs?: number;
  messages: IlinkInboundMessage[];
}

const updateBatchSchema = z.object({
  ret: z.number(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
  msgs: z.array(messageSchema).default([]),
  get_updates_buf: z.string().default(''),
  longpolling_timeout_ms: z.number().int().positive().optional(),
});

export const sendMessageResponseSchema = z.object({
  ret: z.number(),
  errmsg: z.string().optional(),
});

export function parseQrCreation(raw: unknown): IlinkQrCreation {
  const parsed = qrCreationSchema.safeParse(raw);
  if (!parsed.success) throw IlinkError.schema('qr creation');
  return { qrcode: parsed.data.qrcode, qrcodeImageContent: parsed.data.qrcode_img_content };
}

export function parseQrStatus(raw: unknown): IlinkQrStatus {
  const parsed = qrStatusSchema.safeParse(raw);
  if (!parsed.success) throw IlinkError.schema('qr status');
  return parsed.data;
}

export function parseUpdateBatch(raw: unknown): IlinkUpdateBatch {
  const parsed = updateBatchSchema.safeParse(raw);
  if (!parsed.success) throw IlinkError.schema('update batch');
  return {
    ret: parsed.data.ret,
    ...(parsed.data.errcode === undefined ? {} : { errcode: parsed.data.errcode }),
    ...(parsed.data.errmsg === undefined ? {} : { errmsg: parsed.data.errmsg }),
    cursor: parsed.data.get_updates_buf,
    ...(parsed.data.longpolling_timeout_ms === undefined ? {} : { longpollingTimeoutMs: parsed.data.longpolling_timeout_ms }),
    messages: parsed.data.msgs.map((message, index) => {
      const text = (message.item_list ?? []).map((item) => item.text_item.text).join('\n').trim();
      const createdAt = new Date(message.create_time_ms ?? Date.now()).toISOString();
      const normalized: IlinkInboundMessage = {
        id: String(message.message_id ?? message.client_id ?? message.seq ?? index),
        fromUserId: message.from_user_id ?? '',
        createdAt,
        text,
      };
      if (message.to_user_id !== undefined) normalized.toUserId = message.to_user_id;
      if (message.session_id !== undefined) normalized.sessionId = message.session_id;
      if (message.group_id !== undefined) normalized.groupId = message.group_id;
      if (message.context_token !== undefined) normalized.contextToken = message.context_token;
      return normalized;
    }).filter((message) => message.fromUserId !== '' && message.text !== ''),
  };
}

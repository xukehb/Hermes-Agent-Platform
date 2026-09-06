import { randomBytes, randomUUID } from 'node:crypto';
import {
  IlinkError,
  parseQrCreation,
  parseQrStatus,
  parseUpdateBatch,
  sendMessageResponseSchema,
  validateIlinkResult,
  type IlinkQrCreation,
  type IlinkQrStatus,
  type IlinkUpdateBatch,
} from './types.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CLIENT_VERSION = '65536';

export type IlinkFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface IlinkApiClientOptions {
  baseUrl?: string;
  token?: string;
  localTokens?: string[];
  fetch?: IlinkFetch;
}

export function validateIlinkBaseUrl(input: string): URL {
  const raw = input.startsWith('https://') || input.startsWith('http://') ? input : 'https://' + input;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IlinkError('ILINK_BASEURL', 'ILINK_BASEURL: invalid iLink base URL');
  }
  if (url.protocol !== 'https:') throw new IlinkError('ILINK_BASEURL', 'ILINK_BASEURL: iLink base URL must use HTTPS');
  if (url.hostname !== 'weixin.qq.com' && !url.hostname.endsWith('.weixin.qq.com')) {
    throw new IlinkError('ILINK_BASEURL', 'ILINK_BASEURL: iLink base URL must be a weixin.qq.com host');
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  url.search = '';
  url.hash = '';
  return url;
}

export class IlinkApiClient {
  private readonly baseUrl: URL;
  private readonly token: string | undefined;
  private readonly localTokens: string[];
  private readonly fetchImpl: IlinkFetch;

  constructor(options: IlinkApiClientOptions = {}) {
    this.baseUrl = validateIlinkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.token = options.token;
    this.localTokens = (options.localTokens ?? []).slice(0, 10);
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async createQr(signal?: AbortSignal): Promise<IlinkQrCreation> {
    return this.request({
      method: 'POST',
      path: 'ilink/bot/get_bot_qrcode?bot_type=3',
      label: 'get_bot_qrcode',
      authenticated: false,
      body: { local_token_list: this.localTokens },
      ...(signal === undefined ? {} : { signal }),
      parse: parseQrCreation,
    });
  }

  async qrStatus(qrcode: string, verifyCode?: string, signal?: AbortSignal): Promise<IlinkQrStatus> {
    const params = new URLSearchParams({ qrcode });
    if (verifyCode !== undefined) params.set('verify_code', verifyCode);
    return this.request({
      method: 'GET',
      path: 'ilink/bot/get_qrcode_status?' + params.toString(),
      label: 'get_qrcode_status',
      authenticated: false,
      ...(signal === undefined ? {} : { signal }),
      parse: parseQrStatus,
    });
  }

  async notifyStart(signal?: AbortSignal): Promise<void> {
    await this.retRequest('ilink/bot/msg/notifystart', 'notifystart', {}, signal);
  }

  async notifyStop(signal?: AbortSignal): Promise<void> {
    await this.retRequest('ilink/bot/msg/notifystop', 'notifystop', {}, signal);
  }

  async getUpdates(cursor: string, signal?: AbortSignal): Promise<IlinkUpdateBatch> {
    return this.request({
      method: 'POST',
      path: 'ilink/bot/getupdates',
      label: 'getupdates',
      authenticated: true,
      body: { get_updates_buf: cursor },
      ...(signal === undefined ? {} : { signal }),
      parse: parseUpdateBatch,
    });
  }

  async sendText(input: { toUserId: string; contextToken: string; text: string }, signal?: AbortSignal): Promise<void> {
    await this.retRequest('ilink/bot/sendmessage', 'sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: input.toUserId,
        client_id: 'hap-' + randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        item_list: [{ type: 1, text_item: { text: input.text } }],
      },
    }, signal);
  }

  private async retRequest(path: string, label: string, body: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.request<{ ret: number; errmsg?: string | undefined }>({
      method: 'POST',
      path,
      label,
      authenticated: true,
      body,
      ...(signal === undefined ? {} : { signal }),
      parse: (raw) => {
        validateIlinkResult(raw);
        const parsed = sendMessageResponseSchema.safeParse(raw);
        if (!parsed.success) throw IlinkError.schema(label);
        return parsed.data;
      },
    });
    if (response.ret !== 0) throw new IlinkError('ILINK_RET', 'ILINK_RET: ' + label + ' returned ret=' + String(response.ret));
  }

  private async request<T>(spec: {
    method: 'GET' | 'POST';
    path: string;
    label: string;
    authenticated: boolean;
    body?: unknown;
    signal?: AbortSignal;
    parse: (raw: unknown) => T;
  }): Promise<T> {
    const url = new URL(spec.path, this.baseUrl);
    const init: RequestInit = {
      method: spec.method,
      headers: this.headers(spec.authenticated),
    };
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
    if (spec.signal !== undefined) init.signal = spec.signal;
    const response = await this.fetchImpl(url, init);
    if (!response.ok) throw IlinkError.http(spec.label, response.status);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw IlinkError.schema(spec.label);
    }
    return spec.parse(raw);
  }

  private headers(authenticated: boolean): Headers {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': CLIENT_VERSION,
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
    });
    if (authenticated && this.token !== undefined) {
      headers.set('Authorization', 'Bearer ' + this.token);
    }
    return headers;
  }
}

import { z } from 'zod';
import type { IlinkApiClient } from './api-client.js';
import { IlinkError, type IlinkQrStatus } from './types.js';
import type { IlinkAccountStore } from './credential-store.js';

export type LoginState =
  | { phase: 'idle' }
  | { phase: 'qr_ready'; qrText: string }
  | { phase: 'scanned' }
  | { phase: 'verification_required' }
  | { phase: 'verification_blocked' }
  | { phase: 'expired' }
  | { phase: 'redirect'; redirectHost: string }
  | { phase: 'already_bound' }
  | { phase: 'connected'; ilinkBotId: string; ilinkUserId?: string }
  | { phase: 'error'; code: string; message: string };

export interface IlinkLoginSessionOptions {
  api: Pick<IlinkApiClient, 'createQr' | 'qrStatus'>;
  store: IlinkAccountStore;
  pollIntervalMs?: number;
  onState: (state: LoginState) => void;
  now?: () => string;
}

export class IlinkLoginSession {
  private readonly api: Pick<IlinkApiClient, 'createQr' | 'qrStatus'>;
  private readonly store: IlinkAccountStore;
  private readonly pollIntervalMs: number;
  private readonly onState: (state: LoginState) => void;
  private readonly now: () => string;
  private generation = 0;
  private aborted = false;
  private state: LoginState = { phase: 'idle' };
  private controller: AbortController | undefined;

  constructor(options: IlinkLoginSessionOptions) {
    this.api = options.api;
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 1200;
    this.onState = options.onState;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.aborted = false;
    try {
      const qr = await this.api.createQr(controller.signal);
      this.publish(generation, { phase: 'qr_ready', qrText: qr.qrcodeImageContent });
      await this.poll(generation, qr.qrcode);
    } catch (error) {
      if (generation !== this.generation || this.aborted) return;
      const code = error instanceof IlinkError ? error.code : 'ILINK_LOGIN_FAILED';
      this.publish(generation, { phase: 'error', code, message: code });
    }
  }

  async refresh(): Promise<void> {
    this.generation += 1;
    await this.start();
  }

  stop(): void {
    this.aborted = true;
    this.generation += 1;
    this.controller?.abort();
  }

  submitVerification(code: string): void {
    if (this.state.phase !== 'verification_required') {
      throw new IlinkError('ILINK_NOT_WAITING_CODE', 'ILINK_NOT_WAITING_CODE');
    }
    z.string().regex(/^\d{4,8}$/).parse(code);
  }

  private async poll(generation: number, qrcode: string): Promise<void> {
    let verifyCode: string | undefined;
    while (generation === this.generation && !this.aborted) {
      const status = await this.api.qrStatus(qrcode, verifyCode, this.controller?.signal);
      verifyCode = undefined;
      if (generation !== this.generation || this.aborted) return;
      const terminal = await this.handleStatus(generation, status);
      if (terminal) return;
      if (this.pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private async handleStatus(generation: number, status: IlinkQrStatus): Promise<boolean> {
    switch (status.status) {
      case 'wait':
        return false;
      case 'scaned':
        this.publish(generation, { phase: 'scanned' });
        return false;
      case 'need_verifycode':
        this.publish(generation, { phase: 'verification_required' });
        return true;
      case 'verify_code_blocked':
        this.publish(generation, { phase: 'verification_blocked' });
        return true;
      case 'scaned_but_redirect':
        this.publish(generation, { phase: 'redirect', redirectHost: status.redirect_host });
        return true;
      case 'binded_redirect':
        this.publish(generation, { phase: 'already_bound' });
        return true;
      case 'expired':
        this.publish(generation, { phase: 'expired' });
        return true;
      case 'confirmed':
        // accountId is a local storage alias, not the server-issued bot identity.
        this.store.saveAccount({
          botToken: status.bot_token,
          ilinkBotId: status.ilink_bot_id,
          ...(status.ilink_user_id === undefined ? {} : { loginUserId: status.ilink_user_id }),
          baseUrl: status.baseurl,
          updatedAt: this.now(),
        });
        this.publish(generation, {
          phase: 'connected',
          ilinkBotId: status.ilink_bot_id,
          ...(status.ilink_user_id === undefined ? {} : { ilinkUserId: status.ilink_user_id }),
        });
        return true;
    }
  }

  private publish(generation: number, state: LoginState): void {
    if (generation !== this.generation || this.aborted) return;
    this.state = state;
    this.onState(redactLoginState(state));
  }
}

export function redactLoginState(state: LoginState): LoginState {
  if (state.phase !== 'qr_ready') return state;
  return { phase: 'qr_ready', qrText: state.qrText };
}

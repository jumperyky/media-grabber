// パイプ経由の最小 CDP クライアント。
// Chrome 137 以降は --load-extension を使う際に --remote-debugging-port が使えず、
// --remote-debugging-pipe (+ --enable-unsafe-extension-debugging) が必要になるため用意する。
import { spawn } from 'node:child_process';

export class PipeCdp {
  constructor(child) {
    this.child = child;
    this.writer = child.stdio[3];
    this.reader = child.stdio[4];
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = Buffer.alloc(0);

    this.reader.on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(0);
      if (end === -1) return;
      const raw = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const slot = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message + ' (' + slot.method + ')'));
      else slot.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.writer.write(JSON.stringify(payload) + '\0');
    });
  }

  /** ターゲットに接続して sessionId を得る。 */
  async attach(targetId) {
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return r.sessionId;
  }

  /** 指定セッションで式を評価して値を返す。 */
  async evaluate(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async getTargets() {
    const r = await this.send('Target.getTargets');
    return r.targetInfos;
  }

  async createTarget(url) {
    const r = await this.send('Target.createTarget', { url });
    return r.targetId;
  }
}

/** --remote-debugging-pipe で Chrome を起動して CDP クライアントを返す。 */
export function launchChrome(chromePath, args) {
  const child = spawn(chromePath, ['--remote-debugging-pipe', ...args], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  return { child, cdp: new PipeCdp(child) };
}

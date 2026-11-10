// A very small Chrome DevTools Protocol driver (no dependencies): enough to
// open pages, click, type and read the DOM from the browser end-to-end test.
// Uses Node's built-in WebSocket and whatever Chrome/Chromium is installed.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p): p is string => Boolean(p));

export const findChrome = () => CANDIDATES.find((p) => existsSync(p)) ?? null;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Browser {
  private ws!: WebSocket;
  private proc!: ChildProcess;
  private dir!: string;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners: ((method: string, params: any, sessionId?: string) => void)[] = [];

  static async launch(opts: { headless?: boolean; width?: number; height?: number } = {}): Promise<Browser> {
    const chrome = findChrome();
    if (!chrome) throw new Error('Chrome or Chromium not found (set CHROME_PATH)');
    const b = new Browser();
    b.dir = mkdtempSync(join(tmpdir(), 'quorum-chrome-'));
    b.proc = spawn(
      chrome,
      [
        ...(opts.headless === false ? [] : ['--headless=new']),
        '--remote-debugging-port=0',
        `--user-data-dir=${b.dir}`,
        `--window-size=${opts.width ?? 1280},${opts.height ?? 900}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-popup-blocking',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${err.slice(-300)}`)), 15_000);
      b.proc.stderr!.on('data', (d) => {
        err += d;
        const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    b.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      b.ws.onopen = () => resolve();
      b.ws.onerror = () => reject(new Error('Could not connect to Chrome'));
    });
    b.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && b.pending.has(msg.id)) {
        const p = b.pending.get(msg.id)!;
        b.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of b.listeners) fn(msg.method, msg.params, msg.sessionId);
      }
    };
    await b.send('Target.setDiscoverTargets', { discover: true });
    return b;
  }

  send<T = any>(method: string, params: unknown = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(fn: (method: string, params: any, sessionId?: string) => void) {
    this.listeners.push(fn);
  }

  private async attach(targetId: string): Promise<Page> {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.cdp('Page.enable');
    await page.cdp('Runtime.enable');
    return page;
  }

  async newPage(url: string): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const page = await this.attach(targetId);
    await page.goto(url);
    return page;
  }

  /** Wait for another tab or popup whose URL contains `part` (for example a payment window). */
  async waitForPage(part: string, timeoutMs = 20_000): Promise<Page> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const { targetInfos } = await this.send('Target.getTargets');
      const hit = targetInfos.find((t: any) => t.type === 'page' && String(t.url).includes(part));
      if (hit) return this.attach(hit.targetId);
      await sleep(200);
    }
    throw new Error(`No page with "${part}" in its URL appeared`);
  }

  async pages(): Promise<{ targetId: string; url: string; type: string }[]> {
    return (await this.send('Target.getTargets')).targetInfos;
  }

  async close() {
    try {
      await this.send('Browser.close');
    } catch {}
    this.proc.kill();
    await sleep(200);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export class Page {
  private browser: Browser;
  private sessionId: string;
  readonly targetId: string;

  constructor(browser: Browser, sessionId: string, targetId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  /** The DevTools session id of this page (used to tell its events apart). */
  get session() {
    return this.sessionId;
  }

  cdp<T = any>(method: string, params: unknown = {}) {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async goto(url: string) {
    await this.cdp('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete" || document.readyState === "interactive"', 30_000);
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async waitFor(expression: string, timeoutMs = 15_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < end) {
      try {
        if (await this.eval(`Boolean(${expression})`)) return;
      } catch (err) {
        last = err; // the page may be navigating
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${expression}${last ? ` (${(last as Error).message})` : ''}`);
  }

  async waitForSelector(selector: string, timeoutMs = 15_000) {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
  }

  /** A real mouse click at the centre of the element. */
  async click(selector: string) {
    await this.waitForSelector(selector);
    const box = await this.eval<{ x: number; y: number }>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }

  /** A real mouse click at page coordinates (works on cross-origin iframes such as PayPal's buttons). */
  async clickAt(x: number, y: number) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  }

  /** Bring this tab to the front: Chrome only delivers typed text to the focused page. */
  async focus() {
    await this.cdp('Page.bringToFront');
  }

  /** Focus an input, clear it and type. Retries until the field really holds the text. */
  async type(selector: string, text: string) {
    await this.waitForSelector(selector);
    const sel = JSON.stringify(selector);
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.focus();
      await this.eval(`(() => { const el = document.querySelector(${sel}); el.focus(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await this.cdp('Input.insertText', { text });
      await sleep(80);
      if ((await this.eval<string>(`(document.querySelector(${sel}) || {}).value || ''`)) === text) return;
      await sleep(300); // the page may have re-rendered the field; try again
    }
    throw new Error(`Could not type into ${selector}`);
  }

  text(selector = 'body') {
    return this.eval<string>(`(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`);
  }

  url() {
    return this.eval<string>('location.href');
  }

  /** Accept the next confirm()/alert() dialog. */
  async acceptDialogs() {
    this.browser.on((method, _params, sessionId) => {
      if (method === 'Page.javascriptDialogOpening' && sessionId === this.sessionId) {
        void this.cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
  }

  async screenshot(file: string) {
    const { data } = await this.cdp('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

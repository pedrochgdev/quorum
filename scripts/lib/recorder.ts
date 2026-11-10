// Records Chrome pages into an MP4: frames come from the DevTools screencast,
// captions and a pointer are drawn inside the page so they are part of the
// picture, and ffmpeg assembles the frames with their real timing.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from './cdp.ts';
import { sleep } from './cdp.ts';

type Frame = { file: string; at: number; speed: number };

export class Recorder {
  private browser: Browser;
  private dir: string;
  private frames: Frame[] = [];
  private active: Page | null = null;
  private n = 0;
  readonly width: number;
  readonly height: number;
  private scale: number;
  /** Footage recorded while speed is 5 plays five times faster in the final video. */
  speed = 1;

  constructor(browser: Browser, dir: string, opts: { width?: number; height?: number; scale?: number } = {}) {
    this.browser = browser;
    this.dir = dir;
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 720;
    this.scale = opts.scale ?? 1.5;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    browser.on((method, params, sessionId) => {
      if (method !== 'Page.screencastFrame') return;
      // Always acknowledge, or Chrome stops sending frames.
      void browser.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      if (!this.active || sessionId !== this.active.session) return;
      const file = join(this.dir, `f${String(++this.n).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(params.data, 'base64'));
      this.frames.push({ file, at: Date.now(), speed: this.speed });
    });
  }

  /** Give a page the video's size. */
  async prepare(page: Page) {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: this.scale, mobile: false });
    await page.cdp('Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {});
  }

  /** Record this page from now on (only one page is recorded at a time). */
  async watch(page: Page) {
    if (this.active && this.active !== page) await this.active.cdp('Page.stopScreencast').catch(() => {});
    this.active = page;
    await this.prepare(page);
    await page.focus().catch(() => {});
    await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: Math.round(this.width * this.scale), maxHeight: Math.round(this.height * this.scale), everyNthFrame: 1 });
  }

  /** Show a caption at the bottom of the page being recorded. Empty text hides it. */
  async caption(text: string) {
    const page = this.active;
    if (!page) return;
    await page
      .eval(
        `(() => {
          let el = document.getElementById('demo-caption');
          if (!el) {
            el = document.createElement('div');
            el.id = 'demo-caption';
            const s = el.style;
            s.position = 'fixed'; s.left = '50%'; s.bottom = '26px'; s.transform = 'translateX(-50%)'; s.zIndex = '2147483646';
            s.maxWidth = '1040px'; s.width = 'max-content'; s.boxSizing = 'border-box'; s.padding = '14px 22px'; s.borderRadius = '14px';
            s.background = 'rgba(20, 22, 21, 0.93)'; s.color = '#fff'; s.font = '500 21px/1.42 system-ui, -apple-system, "Segoe UI", sans-serif';
            s.textAlign = 'center'; s.boxShadow = '0 10px 34px rgba(0,0,0,0.3)'; s.pointerEvents = 'none'; s.transition = 'opacity 0.25s';
            document.body.appendChild(el);
          }
          el.textContent = ${JSON.stringify(text)};
          el.style.opacity = ${JSON.stringify(text ? '1' : '0')};
        })()`,
      )
      .catch(() => {});
  }

  /** Move the on-screen pointer to a point, so viewers see where the click lands. */
  async pointTo(x: number, y: number) {
    const page = this.active;
    if (!page) return;
    await page
      .eval(
        `(() => {
          let el = document.getElementById('demo-pointer');
          if (!el) {
            el = document.createElement('div');
            el.id = 'demo-pointer';
            const s = el.style;
            s.position = 'fixed'; s.left = '640px'; s.top = '360px'; s.width = '26px'; s.height = '26px'; s.margin = '-13px 0 0 -13px'; s.borderRadius = '50%';
            s.background = 'rgba(15, 110, 96, 0.28)'; s.border = '2px solid rgba(15, 110, 96, 0.95)'; s.zIndex = '2147483647'; s.pointerEvents = 'none';
            s.transition = 'left 0.45s ease, top 0.45s ease, transform 0.15s ease';
            document.body.appendChild(el);
          }
          el.style.left = '${x}px';
          el.style.top = '${y}px';
        })()`,
      )
      .catch(() => {});
    await sleep(520);
  }

  private async pulse() {
    await this.active
      ?.eval("(() => { const el = document.getElementById('demo-pointer'); if (!el) return; el.style.transform = 'scale(0.6)'; setTimeout(() => (el.style.transform = 'scale(1)'), 160); })()")
      .catch(() => {});
  }

  /** Scroll an element into view, move the pointer to it and click it. */
  async click(selector: string) {
    const page = this.active!;
    await page.waitForSelector(selector);
    const sel = JSON.stringify(selector);
    await page.eval(`document.querySelector(${sel}).scrollIntoView({ block: 'center', behavior: 'smooth' })`);
    // Wait for the smooth scroll (and any re-render) to settle, so the click lands on the element.
    const where = () =>
      page.eval<{ x: number; y: number } | null>(
        `(() => { const el = document.querySelector(${sel}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      );
    let box = await where();
    for (let i = 0; i < 25; i++) {
      await sleep(160);
      const next = await where();
      if (box && next && next.x === box.x && next.y === box.y) break;
      box = next;
    }
    if (!box) throw new Error(`${selector} disappeared before it could be clicked`);
    await this.pointTo(box.x, box.y);
    // The pointer takes a moment to travel; confirm the target is still there before pressing.
    const final = (await where()) ?? box;
    await this.pulse();
    await page.clickAt(final.x, final.y);
    await sleep(250);
  }

  async clickAt(x: number, y: number) {
    await this.pointTo(x, y);
    await this.pulse();
    await this.active!.clickAt(x, y);
    await sleep(250);
  }

  /** Type into a field one character at a time, like a person. */
  async type(selector: string, text: string, perChar = 38) {
    const page = this.active!;
    await this.click(selector);
    await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ''; })()`);
    for (const ch of text) {
      await page.cdp('Input.insertText', { text: ch });
      await sleep(perChar);
    }
  }

  async scrollTo(selector: string, block: 'start' | 'center' = 'start') {
    await this.active!.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: '${block}', behavior: 'smooth' }); })()`).catch(() => {});
    await sleep(900);
  }

  async stop() {
    if (this.active) await this.active.cdp('Page.stopScreencast').catch(() => {});
    this.active = null;
  }

  /** Assemble the frames. `maxSeconds` speeds the whole video up slightly if it runs long. */
  render(out: string, maxSeconds = 168): { seconds: number; frames: number } {
    const frames = this.frames;
    if (frames.length < 2) throw new Error('Nothing was recorded');
    let total = 0;
    const durations = frames.map((f, i) => {
      const next = i + 1 < frames.length ? frames[i + 1].at : f.at + 1500;
      const d = Math.max(0.02, (next - f.at) / 1000 / f.speed);
      total += d;
      return d;
    });
    const fit = total > maxSeconds ? total / maxSeconds : 1;
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${(durations[i] / fit).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1)!.file}'\n`;
    const listFile = join(this.dir, 'frames.txt');
    writeFileSync(listFile, list);
    const w = Math.round(this.width * this.scale);
    const h = Math.round(this.height * this.scale);
    const r = spawnSync(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', `fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-movflags', '+faststart',
        out,
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-600)}`);
    return { seconds: Math.round(total / fit), frames: frames.length };
  }
}

/**
 * Payment page security checks (static + optional live).
 *
 * Static (default): CSP parity `_headers` vs nginx, source/dist index.html allowlists,
 * no Google Fonts in `frontend/public/*.html`.
 *
 * Live (`--live` or `PAYMENT_PAGE_URL`): HTTPS GET and verify headers + HTML allowlist.
 *
 * @example
 * npm run check:payment-security
 * PAYMENT_PAGE_URL=https://example.com/ npm run check:payment-security:live
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Must match [frontend/public/_headers](frontend/public/_headers) and [nginx/security-headers.conf](nginx/security-headers.conf). */
export const EXPECTED_CSP =
  "default-src 'self'; script-src 'self' https://js.pay.jp; style-src 'self'; font-src 'self'; connect-src 'self' https://api.pay.jp; frame-src https://js.pay.jp; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:";

const PAYJP_PAY_SCRIPT = 'https://js.pay.jp/v2/pay.js';
const SOURCE_MAIN = '/src/main.ts';

function normalizeCsp(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractCspFromHeadersFile(content: string): string | null {
  const m = content.match(/Content-Security-Policy:\s*([^\n\r]+)/);
  return m?.[1]?.trim() ?? null;
}

function extractCspFromNginx(content: string): string | null {
  const m = content.match(/add_header Content-Security-Policy "([^"]+)" always;/);
  return m?.[1] ?? null;
}

function assertNoInlineStyle(html: string, label: string): void {
  if (/<style[\s>]/i.test(html)) {
    throw new Error(`${label}: inline <style> is not allowed (remove unsafe-inline CSP requirement)`);
  }
}

function checkSourceIndexHtml(html: string): void {
  assertNoInlineStyle(html, 'frontend/index.html');
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(html)) {
    throw new Error('frontend/index.html: unexpected Google Fonts reference');
  }
  const scripts = [...html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  if (scripts.length !== 2) {
    throw new Error(
      `frontend/index.html: expected exactly 2 external script tags, got ${scripts.length}: ${scripts.join(', ')}`,
    );
  }
  if (!scripts.includes(PAYJP_PAY_SCRIPT)) {
    throw new Error(`frontend/index.html: missing ${PAYJP_PAY_SCRIPT}`);
  }
  if (!scripts.includes(SOURCE_MAIN)) {
    throw new Error(`frontend/index.html: missing ${SOURCE_MAIN}`);
  }
}

function isAllowedDistScriptSrc(src: string): boolean {
  if (src === PAYJP_PAY_SCRIPT) return true;
  if (/^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(src)) return true;
  return false;
}

function checkBuiltIndexHtml(html: string, label: string): void {
  assertNoInlineStyle(html, label);
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(html)) {
    throw new Error(`${label}: unexpected Google Fonts reference`);
  }
  const scripts = [...html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  if (!scripts.includes(PAYJP_PAY_SCRIPT)) {
    throw new Error(`${label}: missing ${PAYJP_PAY_SCRIPT}`);
  }
  for (const s of scripts) {
    if (!isAllowedDistScriptSrc(s)) {
      throw new Error(`${label}: disallowed script src: ${s}`);
    }
  }
  if (
    !/<link[^>]+rel\s*=\s*["']stylesheet["'][^>]+href\s*=\s*["']\/assets\/index-[A-Za-z0-9_-]+\.css["']/i.test(html)
  ) {
    throw new Error(`${label}: expected <link rel="stylesheet" href="/assets/index-*.css">`);
  }
}

function checkPublicHtmlFiles(): void {
  const dir = path.join(REPO_ROOT, 'frontend/public');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.html')) continue;
    const p = path.join(dir, name);
    const content = readFileSync(p, 'utf8');
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(content)) {
      throw new Error(`${p}: must not reference Google Fonts (CSP: no third-party font origins)`);
    }
    if (/<style[\s>]/i.test(content)) {
      throw new Error(`${p}: inline <style> is not allowed under current CSP`);
    }
  }
}

function readUtf8(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function runStaticChecks(): void {
  const headersPath = path.join(REPO_ROOT, 'frontend/public/_headers');
  const nginxPath = path.join(REPO_ROOT, 'nginx/security-headers.conf');
  const headersContent = readUtf8(headersPath);
  const nginxContent = readUtf8(nginxPath);

  const cspHeaders = extractCspFromHeadersFile(headersContent);
  const cspNginx = extractCspFromNginx(nginxContent);
  if (!cspHeaders) throw new Error('Could not parse Content-Security-Policy from frontend/public/_headers');
  if (!cspNginx) throw new Error('Could not parse Content-Security-Policy from nginx/security-headers.conf');

  if (normalizeCsp(cspHeaders) !== normalizeCsp(cspNginx)) {
    throw new Error(`CSP mismatch between _headers and nginx.\n_headers:\n${cspHeaders}\n\nnginx:\n${cspNginx}`);
  }
  if (normalizeCsp(cspHeaders) !== normalizeCsp(EXPECTED_CSP)) {
    throw new Error(
      `CSP differs from EXPECTED_CSP in scripts/check-payment-page-security.ts.\nExpected:\n${EXPECTED_CSP}\n\nActual:\n${cspHeaders}`,
    );
  }

  const indexPath = path.join(REPO_ROOT, 'frontend/index.html');
  checkSourceIndexHtml(readUtf8(indexPath));

  const distIndexPath = path.join(REPO_ROOT, 'frontend/dist/index.html');
  if (!existsSync(distIndexPath)) {
    throw new Error('frontend/dist/index.html not found — run npm run build:frontend before check:payment-security');
  }
  checkBuiltIndexHtml(readUtf8(distIndexPath), 'frontend/dist/index.html');

  checkPublicHtmlFiles();
}

async function runLiveCheck(urlStr: string): Promise<void> {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:') {
    throw new Error('PAYMENT_PAGE_URL must use https:');
  }
  const res = await fetch(urlStr, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`GET ${urlStr} failed: HTTP ${res.status}`);
  }
  if (!res.url.startsWith('https://')) {
    throw new Error(`Final URL must be https: ${res.url}`);
  }

  const csp = res.headers.get('content-security-policy');
  if (!csp) {
    throw new Error('Response missing Content-Security-Policy');
  }
  if (normalizeCsp(csp) !== normalizeCsp(EXPECTED_CSP)) {
    throw new Error(`Live CSP mismatch.\nExpected:\n${EXPECTED_CSP}\n\nGot:\n${csp}`);
  }

  const hsts = res.headers.get('strict-transport-security');
  if (!hsts || !/max-age=\d+/i.test(hsts)) {
    throw new Error(`Strict-Transport-Security missing or invalid: ${hsts ?? '(none)'}`);
  }

  const xfo = res.headers.get('x-frame-options');
  if (!xfo || xfo.trim().toUpperCase() !== 'DENY') {
    throw new Error(`Expected X-Frame-Options: DENY, got: ${xfo ?? '(none)'}`);
  }

  const html = await res.text();
  checkBuiltIndexHtml(html, `live response (${res.url})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const liveFlag = args.includes('--live');

  runStaticChecks();
  console.log('check-payment-page-security: all static checks passed.');

  if (liveFlag) {
    const paymentUrl = process.env.PAYMENT_PAGE_URL?.trim();
    if (!paymentUrl) {
      throw new Error('Live check: set PAYMENT_PAGE_URL=https://.../ (production HTTPS URL)');
    }
    await runLiveCheck(paymentUrl);
    console.log(`check-payment-page-security: live check OK (${paymentUrl}).`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

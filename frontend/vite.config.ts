import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const certsDir = path.resolve(__dirname, '../.certs');
const certFile = path.join(certsDir, 'www.and--line.com.pem');
const keyFile = path.join(certsDir, 'www.and--line.com-key.pem');
const hasLocalCerts = fs.existsSync(certFile) && fs.existsSync(keyFile);

export default defineConfig({
  envDir: path.resolve(__dirname, '..'),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: ['www.and--line.com'],
    ...(hasLocalCerts && {
      https: {
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
      },
    }),
    proxy: {
      '/v1': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});

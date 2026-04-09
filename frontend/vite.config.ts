import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const certsDir = path.resolve(__dirname, '../.certs');
const certFile = path.join(certsDir, '116.80.50.44+3.pem');
const keyFile = path.join(certsDir, '116.80.50.44+3-key.pem');
const hasLocalCerts = fs.existsSync(certFile) && fs.existsSync(keyFile);

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
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

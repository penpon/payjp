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
    rollupOptions: {
      input: {
        // Marketing + legal static pages
        home: path.resolve(__dirname, 'index.html'),
        service: path.resolve(__dirname, 'service.html'),
        terms: path.resolve(__dirname, 'terms-of-service.html'),
        privacy: path.resolve(__dirname, 'privacy-policy.html'),
        legal: path.resolve(__dirname, 'specified-commercial-transactions.html'),
        notfound: path.resolve(__dirname, '404.html'),
        // Member page hosts the PAY.JP subscription SPA
        // (access gate → Discord OAuth → plan → PAY.JP card → 3DS)
        member: path.resolve(__dirname, 'member.html'),
      },
    },
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

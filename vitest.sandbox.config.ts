import { defineConfig } from 'vitest/config';

// Testes de rede contra o sandbox do Mercado Pago. Fora do `npm test`.
export default defineConfig({
  test: {
    include: ['test/sandbox/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});

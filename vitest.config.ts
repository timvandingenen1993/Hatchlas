import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Keep the test runner independent from Tailwind's optional native oxide binding.
// The application build still uses the full Vite configuration.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

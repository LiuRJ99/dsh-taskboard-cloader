import { defineConfig } from 'tsdown'
import host from './tsdown.host.config.ts'
import client from './tsdown.client.config.ts'

// tsdown cleans shared output directories once before any config emits files.
// Single-half configs stay additive so they preserve the other half's output.
export default defineConfig([
  ...host.map(config => ({ ...config, clean: true })),
  { ...client, clean: true },
])

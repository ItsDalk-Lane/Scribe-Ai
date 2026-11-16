import { createRequire } from 'node:module';

/** Keep Node built-ins and proxy packages lazy while remaining compatible with the CJS bundle. */
export const nodeRequire = createRequire(__filename);

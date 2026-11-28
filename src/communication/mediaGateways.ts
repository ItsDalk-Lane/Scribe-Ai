import type { MediaAdapter } from './mediaApi';
import { cloudflareMedia } from './cloudflareMedia';
import { fireworksMedia } from './fireworksMedia';
import { huggingFaceMedia } from './huggingFaceMedia';
import { openCodeMedia } from './openCodeMedia';
import { openRouterMedia } from './openRouterMedia';
import { radiusMedia } from './radiusMedia';
import { togetherMedia } from './togetherMedia';
import { vercelMedia } from './vercelMedia';

export const gatewayMedia: readonly MediaAdapter[] = [
	...openRouterMedia,
	...vercelMedia,
	...cloudflareMedia,
	...openCodeMedia,
	...togetherMedia,
	...huggingFaceMedia,
	...radiusMedia,
	...fireworksMedia,
];

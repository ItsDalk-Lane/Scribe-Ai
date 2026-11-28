import type { MediaAdapter } from './mediaApi';
import { antLingMedia } from './mediaAntLing';
import { bailianMedia } from './mediaBailian';
import { deepSeekMedia } from './mediaDeepSeek';
import { miniMaxMedia } from './mediaMiniMax';
import { mimoMedia } from './mediaMiMo';
import { zaiMedia } from './mediaZai';

export const chineseMedia: readonly MediaAdapter[] = [...bailianMedia, ...miniMaxMedia, ...mimoMedia, ...antLingMedia, ...zaiMedia, ...deepSeekMedia];

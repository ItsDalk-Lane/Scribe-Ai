import { googleMedia } from './mediaGoogle';
import { hostedMedia } from './mediaHosted';
import { nvidiaMedia } from './mediaNvidia';
import { openAiMedia } from './mediaOpenAi';
import { partialMedia } from './mediaDirectPartials';
import { xaiMedia } from './mediaXai';
import type { MediaAdapter } from './mediaApi';

export const directMedia: readonly MediaAdapter[] = [...xaiMedia, ...openAiMedia, ...googleMedia, ...partialMedia, ...hostedMedia, ...nvidiaMedia];

import { Buffer } from 'node:buffer';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeneratedMediaRef } from '../../types';
import { openStoredFile } from './jsonFile';
import { isGeneratedMediaRef } from './paths';

export async function resolveGeneratedMediaPath(vaultRoot: string, configDir: string, media: GeneratedMediaRef): Promise<string> {
	if (!isGeneratedMediaRef(media)) throw new Error('媒体文件路径无效。');
	const path = media.path.toLowerCase();
	const config = configDir.replace(/\\/gu, '/').toLowerCase();
	if (path === config || path.startsWith(config + '/')) throw new Error('不能预览配置目录中的文件。');
	const absolute = join(await realpath(vaultRoot), media.path);
	const stat = await lstat(absolute);
	if (!stat.isFile() || stat.nlink !== 1 || await realpath(absolute) !== absolute) {
		throw new Error('媒体文件的位置已变化。');
	}
	return absolute;
}

export async function readGeneratedPcmAsWave(vaultRoot: string, configDir: string, media: GeneratedMediaRef): Promise<Uint8Array<ArrayBuffer>> {
	const path = await resolveGeneratedMediaPath(vaultRoot, configDir, media);
	if (media.sampleRate === undefined) throw new Error('PCM 音频缺少采样率。');
	const { file, stat } = await openStoredFile(path);
	try {
		const current = await lstat(path);
		if (current.ino !== stat.ino || current.dev !== stat.dev || await realpath(path) !== path) throw new Error('媒体文件的位置已变化。');
		if (!stat.size || stat.size > 8 * 1024 * 1024 || stat.size % 2) throw new Error('PCM 音频大小无效。');
		const wave = Buffer.alloc(44 + stat.size);
		wave.write('RIFF', 0);
		wave.writeUInt32LE(wave.length - 8, 4);
		wave.write('WAVEfmt ', 8);
		wave.writeUInt32LE(16, 16);
		// Agent Plan PCM 的裸采样为 16-bit little-endian 单声道。
		wave.writeUInt16LE(1, 20);
		wave.writeUInt16LE(1, 22);
		wave.writeUInt32LE(media.sampleRate, 24);
		wave.writeUInt32LE(media.sampleRate * 2, 28);
		wave.writeUInt16LE(2, 32);
		wave.writeUInt16LE(16, 34);
		wave.write('data', 36);
		wave.writeUInt32LE(stat.size, 40);
		let offset = 44;
		while (offset < wave.length) {
			const { bytesRead } = await file.read(wave, offset, wave.length - offset);
			if (!bytesRead) throw new Error('PCM 音频长度已变化。');
			offset += bytesRead;
		}
		return wave;
	} finally {
		await file.close();
	}
}

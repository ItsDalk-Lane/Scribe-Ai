import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../../types';
import { formatWorkingElapsed } from '../formatWorkingElapsed';
import { shimmerBands } from '../shimmerBands';
import { workingIntent } from '../workingIntent';

void test('working elapsed displays tenths through minute and hour boundaries', () => {
	const text = { chatWorkingSeconds: '{s}秒', chatWorkingMinutes: '{m}分{s}秒', chatWorkingHours: '{h}时{m}分{s}秒' };
	assert.equal(formatWorkingElapsed(0, text), '0.0秒');
	assert.equal(formatWorkingElapsed(59_900, text), '59.9秒');
	assert.equal(formatWorkingElapsed(60_000, text), '1分0.0秒');
	assert.equal(formatWorkingElapsed(3_599_900, text), '59分59.9秒');
	assert.equal(formatWorkingElapsed(3_600_000, text), '1时0分0.0秒');
	assert.equal(formatWorkingElapsed(91_223_500, text), '25时20分23.5秒');
});

void test('shimmer uses the classic strength bands and loops at 30 characters per second', () => {
	const timeAt = (position: number) => position * 1000 / 30;
	assert.equal(shimmerBands(13, timeAt(16)), '0011222221100');
	assert.equal(shimmerBands(13, timeAt(17)), '0001122222110');
	assert.equal(shimmerBands(13, timeAt(16) + 1100), '0011222221100');
	assert.equal(shimmerBands(13, 0), '0'.repeat(13));
	assert.equal(shimmerBands(13, timeAt(32)), '0'.repeat(13));
	assert.equal(shimmerBands(20, timeAt(16)).slice(0, 13), '0011222221100');
	const timeAtStrength = (strength: number) => timeAt(10 - 6 * Math.acos(2 * strength - 1) / Math.PI);
	assert.equal(shimmerBands(1, timeAtStrength(0.65001)), '2');
	assert.equal(shimmerBands(1, timeAtStrength(0.64999)), '1');
	assert.equal(shimmerBands(1, timeAtStrength(0.22001)), '1');
	assert.equal(shimmerBands(1, timeAtStrength(0.21999)), '0');
});

void test('working intent follows the active call in the newest assistant reply', () => {
	const messages: Message[] = [
		{ role: 'assistant', content: '', toolCalls: [
			{ id: '1', name: 'Read', input: { i: ' 正在读取设置。 ' } },
			{ id: '2', name: 'Read', input: { intent: '正在核对模型角色...' } },
			{ id: '3', name: 'Read', input: { i: 'Reading model roles' } },
		] },
		{ role: 'tool', content: 'Settings', toolCallId: '1' },
	];
	assert.equal(workingIntent(messages, '1'), '正在读取设置');
	assert.equal(workingIntent(messages, '2'), '正在核对模型角色');
	assert.equal(workingIntent(messages, '3'), '正在核对模型角色');
	assert.equal(workingIntent(messages), '正在核对模型角色');
	assert.equal(workingIntent([...messages, { role: 'assistant', content: 'Continuing' }]), undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillMentionParts } from '../components/skillMentionText';

test('skill mention parts split chips and ignore invalid or overlapping ranges', () => {
	const parts = skillMentionParts('$alpha $beta', [
		{ id: 'a', name: 'alpha', start: 0, end: 6 },
		{ id: 'b', name: 'beta', start: 7, end: 12 },
		{ id: 'c', name: 'bad', start: 40, end: 60 },
		{ id: 'd', name: 'overlap', start: 3, end: 5 },
	]);
	assert.deepEqual(parts, [{ text: '$alpha', mention: true }, ' ', { text: '$beta', mention: true }]);
	assert.deepEqual(skillMentionParts('plain text'), ['plain text']);
});

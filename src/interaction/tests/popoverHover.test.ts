import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInPopoverGap } from '../components/usePopoverHover';

void test('a detached hover panel stays open when crossing a real gap in either direction', () => {
	const trigger = { left: 90, right: 190, top: 205, bottom: 240 };
	const panel = { left: 16, right: 336, top: 80, bottom: 200 };
	assert.equal(isInPopoverGap(trigger, panel, 150, 203), true);
	assert.equal(isInPopoverGap(trigger, panel, 220, 202), true);
	assert.equal(isInPopoverGap(trigger, panel, 220, 205), false);
	assert.equal(isInPopoverGap(trigger, panel, 150, 241), false);
	assert.equal(isInPopoverGap(trigger, { ...panel, top: 245, bottom: 365 }, 150, 243), true);
	assert.equal(isInPopoverGap(trigger, { ...panel, top: 240, bottom: 365 }, 150, 240), false);
});

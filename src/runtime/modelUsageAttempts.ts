import type { ModelUsageReceipt } from '../types';

export function modelUsageAttempts(record?: (receipt: ModelUsageReceipt) => Promise<void>) {
	const destinations = new Set<string>();
	let receipt: ModelUsageReceipt = {};
	let saved: Promise<void> | undefined;
	const save = () => saved ??= record?.(receipt) ?? Promise.resolve();
	return {
		get receipt() { return receipt; },
		get started() {
			return destinations.size > 0 || receipt.cost !== undefined || receipt.estimatedUsage !== undefined
				|| Object.keys(receipt.reportedUsage ?? {}).length > 0;
		},
		update(this: void, latest: ModelUsageReceipt) { receipt = latest; },
		async transmitted(address: string, signal?: AbortSignal) {
			// 重定向可以有多个地址；再次向同一地址发送时才开始下一次尝试。
			if (destinations.has(address)) {
				await save();
				signal?.throwIfAborted();
				destinations.clear();
				receipt = {};
				saved = undefined;
			}
			destinations.add(address);
		},
		save,
	};
}

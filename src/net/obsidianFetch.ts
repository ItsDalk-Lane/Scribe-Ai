import { requestUrl } from 'obsidian';

/** 宿主网络通道：插件运行环境不带来源策略中的 fetch，统一通过 requestUrl 出入 */
export interface HostFetch {
	post(
		url: string,
		body: string,
		headers: Record<string, string>,
	): Promise<{ status: number; text: string }>;
}

export function createHostFetch(): HostFetch {
	return {
		post: async (url, body, headers) => {
			const response = await requestUrl({
				url,
				method: 'POST',
				body,
				headers,
				throw: false,
			});
			return { status: response.status, text: response.text };
		},
	};
}

import type { ModelConnection, Transport } from '../types';

export function needsBufferedGroqSchema({ api, baseUrl }: ModelConnection): boolean {
	const address = URL.parse(baseUrl);
	return api === 'openai-completions' && address?.origin === 'https://api.groq.com'
		&& address.pathname.replace(/\/$/u, '') === '/openai/v1';
}

/** Groq's strict schema endpoint supplies a complete response. Replay it through the SDK's chat stream reader. */
export function bufferedGroqSchemaFetch(fetch: Transport['fetch']): Transport['fetch'] {
	return async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== 'https://api.groq.com/openai/v1/chat/completions' || request.method !== 'POST') return fetch(request);
		const body = await request.json() as Record<string, unknown>;
		const { stream_options: _streamOptions, ...fields } = body;
		const headers = new Headers(request.headers);
		headers.delete('content-length');
		const response = await fetch(new Request(request, { headers, body: JSON.stringify({ ...fields, stream: false }) }));
		if (!response.ok) return response;
		const completion = await response.json() as {
			id: string; model: string; created: number; choices: { index: number; finish_reason: string; message: unknown }[]; usage?: unknown;
		};
		if (!Array.isArray(completion.choices)) throw new Error('Groq 未返回有效的结构化答复。');
		const chunk = {
			...completion, object: 'chat.completion.chunk',
			choices: completion.choices.map(({ message, ...choice }) => ({ ...choice, delta: message })),
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			status: response.status, headers: { 'content-type': 'text/event-stream' },
		});
	};
}

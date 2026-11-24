type Fields = Record<string, unknown>;

export function supportsResponseSchema(api: string, baseUrl?: string, modelId?: string): boolean {
	const url = URL.parse(baseUrl ?? '');
	if (url?.hostname === 'api.meta.ai') return api === 'openai-completions';
	if (api === 'openai-completions' && url && ['open.bigmodel.cn', 'api.z.ai'].includes(url.hostname)) {
		const path = url.pathname.replace(/\/$/u, '');
		if (path === '/api/paas/v4' || path === '/api/coding/paas/v4') {
			return url.origin === 'https://open.bigmodel.cn' && path === '/api/coding/paas/v4' && modelId === 'glm-5.3-flash';
		}
	}
	return ['openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'openai-completions',
		'anthropic-messages', 'google-generative-ai', 'google-vertex', 'bedrock-converse-stream', 'mistral-conversations'].includes(api);
}

export function applyResponseSchema(payload: unknown, api: string, schema: Fields, baseUrl: string): unknown {
	if (typeof payload !== 'object' || !payload || Array.isArray(payload)) throw new Error('模型服务未提供可扩展的请求。');
	const result: Fields = { ...payload };
	const jsonSchema = { name: 'scribe_response', strict: true, schema };
	if (URL.parse(baseUrl)?.hostname === 'openrouter.ai' && api !== 'anthropic-messages') {
		result.provider = { ...(result.provider as Fields | undefined), require_parameters: true };
	}
	switch (api) {
		case 'anthropic-messages':
			result.output_config = { ...(result.output_config as Fields | undefined), format: { type: 'json_schema', schema } };
			break;
		case 'google-generative-ai':
		case 'google-vertex':
			result.config = { ...(result.config as Fields | undefined), responseMimeType: 'application/json', responseJsonSchema: schema };
			break;
		case 'bedrock-converse-stream':
			result.outputConfig = { ...(result.outputConfig as Fields | undefined),
				textFormat: { type: 'json_schema', structure: { jsonSchema: { schema: JSON.stringify(schema), name: jsonSchema.name } } } };
			break;
		case 'openai-completions':
		case 'mistral-conversations':
			result.response_format = { type: 'json_schema', json_schema: jsonSchema };
			break;
		default:
			result.text = { ...(result.text as Fields | undefined), format: { type: 'json_schema', ...jsonSchema } };
	}
	return result;
}

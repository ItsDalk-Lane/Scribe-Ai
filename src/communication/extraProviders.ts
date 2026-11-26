import type { Api, Model, ModelInputModality, ThinkingLevelMap } from '@earendil-works/pi-ai';

/** 目录外的第一方服务商：按 pi 的 Model 结构补全元数据，走与内置 Provider 相同的注册与请求路径 */
export interface ExtraProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ModelInputModality[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Model<'openai-completions'>['compat'];
}

export interface ExtraProviderDef {
	id: string;
	name: string;
	baseUrl: string;
	api: Api;
	/** 复用目录内服务商的模型元数据（连同 cost/compat/inputLimits 一起），避免手抄差异 */
	cloneFrom?: string;
	/** 只克隆这些模型 id；缺省克隆全部 */
	cloneModelIds?: string[];
	models: ExtraProviderModel[];
}

// 图片预处理与 OpenAI 官方模型一致；Ark 未公开更细的限制
const IMAGE_LIMITS = {
	maxRequestBytes: 536870912,
	images: { maxPerRequest: 1500, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } },
} as const;

// 与 pi 的 Qwen Token Plan 目录一致；自定义百炼端点无法靠 URL 自动识别这些行为
const QWEN_COMPAT: NonNullable<Model<'openai-completions'>['compat']> = {
	supportsStrictMode: true,
	thinkingFormat: 'qwen',
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsReasoningEffort: false,
};
const QWEN_EFFORT_COMPAT = { ...QWEN_COMPAT, supportsReasoningEffort: true };

const QWEN4_MAX: ExtraProviderModel = {
	id: 'qwen4-max',
	name: 'Qwen4-Max',
	reasoning: true,
	input: ['text', 'image'],
	contextWindow: 1_000_000,
	maxTokens: 262_144,
	// 官方档位：low / high / xhigh；medium 会映射到 high
	thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'high', high: 'high', xhigh: 'xhigh', max: null },
	compat: QWEN_EFFORT_COMPAT,
};

const QWEN4_MAX_PREVIEW: ExtraProviderModel = {
	id: 'qwen4-max-preview',
	name: 'Qwen4-Max-Preview',
	reasoning: true,
	input: ['text', 'image'],
	contextWindow: 1_000_000,
	maxTokens: 393_216,
	// 预览版官方档位：low / medium / xhigh；预览期结束由官方下线
	thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null },
	compat: QWEN_EFFORT_COMPAT,
};

const QWEN35_PLUS: ExtraProviderModel = {
	id: 'qwen3.5-plus',
	name: 'Qwen3.5 Plus',
	reasoning: true,
	input: ['text', 'image'],
	contextWindow: 1_000_000,
	maxTokens: 65_536,
	compat: QWEN_COMPAT,
};

const BAILIAN_TOKEN_PLAN_COMMON = [
	'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus',
	'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-0731', 'glm-5.3',
];

const BAILIAN_CODING_MODELS = ['qwen3.7-plus', 'qwen3.6-plus', 'kimi-k2.5', 'glm-5', 'MiniMax-M2.5'];

const BAILIAN_PAYG_MODELS = [
	'deepseek-v4-pro', 'deepseek-v4-flash-0731', 'deepseek-v4.1-flash',
	'kimi-k2.6', 'glm-5.1', 'MiniMax-M2.5',
	'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash',
];

export const EXTRA_PROVIDERS: ExtraProviderDef[] = [
	{
		id: 'volcengine-agent-plan',
		name: '火山 Agent Plan',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
		api: 'openai-completions',
		models: [
			{
				id: 'ark-code-latest',
				name: 'Ark Code Latest',
				reasoning: false,
				input: ['text'],
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	},
	{
		id: 'volcengine-coding-plan',
		name: '火山 Coding Plan',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
		api: 'openai-completions',
		models: [
			{
				id: 'ark-code-latest',
				name: 'Ark Code Latest',
				reasoning: false,
				input: ['text'],
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	},
	{
		id: 'bailian-token-plan',
		name: '阿里云百炼 Token Plan',
		baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
		api: 'openai-completions',
		// 个人版/团队版默认只展示官方清单的交集；套餐专属模型仍可手动添加
		cloneFrom: 'qwen-token-plan-cn',
		cloneModelIds: BAILIAN_TOKEN_PLAN_COMMON,
		models: [QWEN4_MAX_PREVIEW],
	},
	{
		id: 'bailian-coding-plan',
		name: '阿里云百炼 Coding Plan',
		baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
		api: 'openai-completions',
		cloneFrom: 'qwen-token-plan-cn',
		cloneModelIds: BAILIAN_CODING_MODELS,
		models: [QWEN35_PLUS],
	},
	{
		id: 'bailian-payg',
		name: '阿里云百炼（按量付费）',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		api: 'openai-completions',
		cloneFrom: 'qwen-token-plan-cn',
		cloneModelIds: BAILIAN_PAYG_MODELS,
		models: [QWEN4_MAX],
	},
	{
		id: 'volcengine-doubao',
		name: 'Volcengine Doubao',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
		api: 'openai-completions',
		models: [
			{
				id: 'doubao-seed-2-1-pro-260915',
				name: 'Doubao Seed 2.1 Pro',
				// 未核实官方推理参数前按普通聊天模型调用，避免发送错误的 reasoning 字段
				reasoning: false,
				input: ['text', 'image'],
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	},
];

export const EXTRA_IMAGE_LIMITS = IMAGE_LIMITS;

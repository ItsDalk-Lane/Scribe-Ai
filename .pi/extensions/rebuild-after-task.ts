/**
 * Rebuild hook: after every agent run settles, rebuild the plugin and sync it into
 * the test vault, so a finished task is never left with a stale main.js.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
	pi.on('agent_settled', async (event, ctx) => {
		if (event.aborted) return;
		ctx.ui.setStatus('scribe-rebuild', 'rebuilding plugin');
		const { code, stderr } = await pi.exec('npm', ['run', 'build'], { cwd: ctx.cwd });
		ctx.ui.setStatus('scribe-rebuild', undefined);
		if (code !== 0) {
			ctx.ui.notify(`Rebuild failed: ${stderr.trim().split('\n').slice(-3).join(' | ')}`, 'error');
		}
	});
}

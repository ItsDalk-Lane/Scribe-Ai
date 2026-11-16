import { InteractionContext } from './context';
import ApprovalView from './components/ApprovalView';
import ContextPicker from './components/ContextPicker';
import ExecutionView from './components/ExecutionView';
import TaskInput from './components/TaskInput';
import type { ScribeServices } from '../types';

/** 交互界面的整体组合：只负责摆放区域，状态经 context 传递 */
export default function App({ services }: { services: ScribeServices }) {
	const state = { services, activeTaskId: null };
	return (
		<InteractionContext.Provider value={state}>
			<div className="scribe-app">
				<ContextPicker />
				<ExecutionView />
				<ApprovalView />
				<TaskInput />
			</div>
		</InteractionContext.Provider>
	);
}

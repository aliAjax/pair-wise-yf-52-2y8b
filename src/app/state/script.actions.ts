import { createAction, props } from '@ngrx/store';
import { EntryStatus, ResolveWay, ScriptVersion } from './script.models';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());

// 排练窗口里的四类改动，全部只生成「待同步操作」，不直接碰正式快照。
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: EntryStatus }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: EntryStatus }>());
export const changeCueTiming = createAction('[Script] Change Cue Timing', props<{ id: string; timing: string }>());
export const discardOp = createAction('[Script] Discard Op', props<{ opId: string }>());

// 冲突不能静默覆盖：按来源列清后，由人逐条裁决。
export const resolveConflict = createAction('[Script] Resolve Conflict', props<{ opId: string; way: ResolveWay }>());

// 整批写出：成功才替换正式快照；失败保留队列。
export const beginCommit = createAction('[Script] Begin Commit');
export const commitSucceeded = createAction('[Script] Commit Succeeded');
export const commitFailed = createAction('[Script] Commit Failed', props<{ reason: string }>());
export const toggleFailNextWrite = createAction('[Script] Toggle Fail Next Write');

// 模拟来源快照变化（编剧/导演端推来新版本）：revision 前进，队列重新评估。
export const simulateSourceChange = createAction('[Script] Simulate Source Change', props<{ scope: 'line' | 'cue-timing' | 'line-remove' | 'reorder' }>());

export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());

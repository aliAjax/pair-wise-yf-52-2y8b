import { createAction, props } from '@ngrx/store';
import { CueDecision, ScriptVersion } from './script.reducer';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: CueDecision }>());
export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());

export const openRehearsalWindow = createAction('[Script] Open Rehearsal Window', props<{ versionId: string }>());
export const closeRehearsalWindow = createAction('[Script] Close Rehearsal Window');
export const reviewLineDraft = createAction(
  '[Script] Review Line Draft',
  props<{ lineId: string; decision: 'accepted' | 'returned'; source: string }>()
);
export const reorderLinesDraft = createAction(
  '[Script] Reorder Lines Draft',
  props<{ from: number; to: number; source: string }>()
);
export const reviewCueDraft = createAction(
  '[Script] Review Cue Draft',
  props<{ cueId: string; decision: 'accepted' | 'returned'; source: string }>()
);
export const editCueTimingDraft = createAction(
  '[Script] Edit Cue Timing Draft',
  props<{ cueId: string; timing: string; source: string }>()
);
export const commitBatch = createAction('[Script] Commit Batch');
export const retryBatch = createAction('[Script] Retry Batch');

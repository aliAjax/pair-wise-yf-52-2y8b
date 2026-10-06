import { createReducer, on } from '@ngrx/store';
import {
  addVersion,
  activateVersion,
  reorderLines,
  reviewCue,
  reviewLine,
  setOnline,
  toggleRehearsal,
  openRehearsalWindow,
  closeRehearsalWindow,
  reviewLineDraft,
  reorderLinesDraft,
  reviewCueDraft,
  editCueTimingDraft,
  commitBatch,
  retryBatch
} from './script.actions';

export type CueDecision = 'pending' | 'accepted' | 'returned';
export type OpStatus = 'pending' | 'conflict' | 'missing-number';
export type WriteState = 'idle' | 'writing' | 'failed' | 'succeeded';

export interface ScriptLine {
  id: string;
  role: string;
  text: string;
  status: CueDecision;
}

export interface ScriptCue {
  id: string;
  scene: string;
  text: string;
  timing: string;
  status: CueDecision;
}

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  /** 来源：编剧同步 / 本地草稿 … */
  source: string;
  note: string;
  lines: ScriptLine[];
  cues: ScriptCue[];
}

export type PendingOpKind = 'reviewLine' | 'reorderLines' | 'reviewCue' | 'editCueTiming';

export interface PendingOp {
  id: string;
  kind: PendingOpKind;
  /** 来源：舞台监督 / 导演 … */
  source: string;
  status: OpStatus;
  lineId?: string;
  cueId?: string;
  decision?: 'accepted' | 'returned';
  from?: number;
  to?: number;
  timing?: string;
}

export interface ConflictItem {
  opId: string;
  source: string;
  kind: PendingOpKind;
  targetId?: string;
  reason: 'changed' | 'missing-number';
  description: string;
}

export interface RehearsalWindow {
  /** 窗口记住的所改版本 */
  baseVersionId: string;
  /** 窗口打开时记住的正式快照 */
  baseSnapshot: ScriptVersion;
  /** 应用了待同步操作的草稿 */
  draft: ScriptVersion;
  /** 待同步操作队列 */
  queue: PendingOp[];
  /** 最近一次写出检测到的冲突（按来源列清） */
  conflicts: ConflictItem[];
  writeState: WriteState;
  writeError: string | null;
  /** 旧数据缺条目编号、已用文本指纹补号并标记迁移 */
  migrated: boolean;
  migrationNotes: string[];
}

export interface ScriptState {
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  rehearsalWindow: RehearsalWindow | null;
  /** 旧数据缺条目编号、已用文本指纹补号并标记迁移 */
  migrated: boolean;
  migrationNotes: string[];
}

const initialVersions: ScriptVersion[] = [
  {
    id: 'v12',
    label: '排练稿 v12',
    playwright: '林编剧',
    source: '编剧同步',
    note: '重写第三场父女冲突，舞台灯光提示延后2拍。',
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', timing: '2拍', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', timing: '0拍', status: 'accepted' }
    ]
  },
  {
    id: 'v13',
    label: '导演修订 v13',
    playwright: '林编剧',
    source: '编剧同步',
    note: '调整周岚结论，加入一次性追光变化。',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending' }
    ],
    cues: [
      { id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', timing: '3拍', status: 'pending' }
    ]
  }
];

/** 文本指纹：旧数据缺条目编号时用来补号 */
function fingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `fp${(hash >>> 0).toString(36)}`;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 旧数据迁移：缺条目编号的用文本指纹补号，并标记迁移 */
function migrateVersion(version: ScriptVersion): { version: ScriptVersion; migrated: boolean; notes: string[] } {
  const notes: string[] = [];
  const used = new Set<string>();
  const lines = version.lines.map((raw) => {
    const line = raw as Partial<ScriptLine>;
    let id = line.id;
    if (!id) {
      const base = `line-${fingerprint(line.text ?? '')}`;
      id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      notes.push(`台词「${(line.text ?? '').slice(0, 12)}…」缺编号，已按文本指纹补号 ${id}`);
    }
    used.add(id);
    return { ...line, id, status: (line.status ?? 'pending') as CueDecision } as ScriptLine;
  });
  const cues = version.cues.map((raw) => {
    const cue = raw as Partial<ScriptCue>;
    let id = cue.id;
    if (!id) {
      const base = `cue-${fingerprint(cue.text ?? '')}`;
      id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      notes.push(`提示「${(cue.text ?? '').slice(0, 12)}…」缺编号，已按文本指纹补号 ${id}`);
    }
    used.add(id);
    return { ...cue, id, timing: cue.timing ?? '', status: (cue.status ?? 'pending') as CueDecision } as ScriptCue;
  });
  return { version: { ...version, lines, cues }, migrated: notes.length > 0, notes };
}

function migrateAll(versions: ScriptVersion[]): { versions: ScriptVersion[]; migrated: boolean; notes: string[] } {
  const allNotes: string[] = [];
  let migrated = false;
  const next = versions.map((version) => {
    const result = migrateVersion(version);
    if (result.migrated) {
      migrated = true;
      allNotes.push(...result.notes);
    }
    return result.version;
  });
  return { versions: next, migrated, notes: allNotes };
}

function getInitialState(): ScriptState {
  const base: ScriptState = {
    versions: initialVersions,
    activeVersionId: 'v12',
    rehearsalMode: false,
    online: true,
    rehearsalWindow: null,
    migrated: false,
    migrationNotes: []
  };
  if (typeof localStorage === 'undefined') return base;
  const saved = localStorage.getItem('yf52-script-state');
  if (!saved) return base;
  const parsed = JSON.parse(saved) as Partial<ScriptState>;
  const result = migrateAll(parsed.versions ?? initialVersions);
  return {
    ...base,
    ...parsed,
    versions: result.versions,
    migrated: result.migrated,
    migrationNotes: result.notes,
    rehearsalWindow: null
  };
}

let opCounter = 0;
function nextOpId(): string {
  opCounter += 1;
  return `op-${Date.now().toString(36)}-${opCounter.toString(36)}`;
}

function findEntry(version: ScriptVersion, op: PendingOp): ScriptLine | ScriptCue | undefined {
  if (op.lineId) return version.lines.find((line) => line.id === op.lineId);
  if (op.cueId) return version.cues.find((cue) => cue.id === op.cueId);
  return undefined;
}

/** 冲突检测：窗口记住的快照 vs 当前正式快照，按来源列清 */
function detectConflicts(window: RehearsalWindow, official: ScriptVersion): ConflictItem[] {
  const conflicts: ConflictItem[] = [];
  for (const op of window.queue) {
    if (op.status === 'missing-number') continue;
    // 排序操作不指向单一条目，单独比对整体顺序
    if (op.kind === 'reorderLines') {
      const baseOrder = window.baseSnapshot.lines.map((line) => line.id).join(',');
      const officialOrder = official.lines.map((line) => line.id).join(',');
      if (baseOrder !== officialOrder) {
        conflicts.push({
          opId: op.id,
          source: op.source,
          kind: op.kind,
          reason: 'changed',
          description: `${op.source}的排序：正式快照中的台词顺序已被改动`
        });
      }
      continue;
    }
    const targetId = op.lineId ?? op.cueId;
    const baseEntry = findEntry(window.baseSnapshot, op);
    const officialEntry = findEntry(official, op);
    if (!officialEntry) {
      conflicts.push({
        opId: op.id,
        source: op.source,
        kind: op.kind,
        targetId,
        reason: 'missing-number',
        description: `${op.source}的${kindLabel(op.kind)}指向条目 ${targetId}，该条目在正式快照中不存在（缺号）`
      });
      continue;
    }
    if (!baseEntry) continue;
    if (op.kind === 'reviewLine' || op.kind === 'reviewCue') {
      if (officialEntry.status !== baseEntry.status || officialEntry.text !== baseEntry.text) {
        conflicts.push({
          opId: op.id,
          source: op.source,
          kind: op.kind,
          targetId,
          reason: 'changed',
          description: `${op.source}的${kindLabel(op.kind)}：条目 ${targetId} 在正式快照中已被改动（${baseEntry.status} → ${officialEntry.status}）`
        });
      }
    } else if (op.kind === 'editCueTiming') {
      const baseCue = baseEntry as ScriptCue;
      const officialCue = officialEntry as ScriptCue;
      if (officialCue.timing !== baseCue.timing) {
        conflicts.push({
          opId: op.id,
          source: op.source,
          kind: op.kind,
          targetId,
          reason: 'changed',
          description: `${op.source}的提示计时：条目 ${targetId} 计时已被改动（${baseCue.timing || '未设置'} → ${officialCue.timing || '未设置'}）`
        });
      }
    }
  }
  return conflicts;
}

function kindLabel(kind: PendingOpKind): string {
  switch (kind) {
    case 'reviewLine':
      return '台词采纳/退回';
    case 'reorderLines':
      return '台词排序';
    case 'reviewCue':
      return '提示采纳/退回';
    case 'editCueTiming':
      return '提示计时改动';
  }
}

/** 把队列里的待同步操作按顺序应用到正式快照 */
function applyOps(version: ScriptVersion, queue: PendingOp[]): ScriptVersion {
  let lines = [...version.lines];
  let cues = [...version.cues];
  for (const op of queue) {
    if (op.status === 'missing-number') continue;
    if (op.kind === 'reviewLine' && op.lineId) {
      lines = lines.map((line) => (line.id === op.lineId ? { ...line, status: op.decision! } : line));
    } else if (op.kind === 'reviewCue' && op.cueId) {
      cues = cues.map((cue) => (cue.id === op.cueId ? { ...cue, status: op.decision! } : cue));
    } else if (op.kind === 'editCueTiming' && op.cueId) {
      cues = cues.map((cue) => (cue.id === op.cueId ? { ...cue, timing: op.timing ?? '' } : cue));
    } else if (op.kind === 'reorderLines' && op.from !== undefined && op.to !== undefined) {
      const [moved] = lines.splice(op.from, 1);
      lines.splice(op.to, 0, moved);
    }
  }
  return { ...version, lines, cues };
}

/** 整批写出：成功才替换正式快照；失败保留队列并按来源列清冲突 */
function attemptCommit(state: ScriptState): ScriptState {
  const window = state.rehearsalWindow;
  if (!window) return state;
  if (!state.online) {
    return {
      ...state,
      rehearsalWindow: {
        ...window,
        writeState: 'failed',
        writeError: '当前离线，整批写出未执行；队列已保留，恢复网络后可重试。'
      }
    };
  }
  const official = state.versions.find((version) => version.id === window.baseVersionId);
  if (!official) return state;
  const conflicts = detectConflicts(window, official);
  if (conflicts.length > 0) {
    const conflictOpIds = new Set(conflicts.map((conflict) => conflict.opId));
    const queue = window.queue.map((op) =>
      conflictOpIds.has(op.id) ? { ...op, status: 'conflict' as OpStatus } : op
    );
    return {
      ...state,
      rehearsalWindow: { ...window, queue, conflicts, writeState: 'failed', writeError: null }
    };
  }
  const updated = applyOps(official, window.queue);
  return {
    ...state,
    versions: state.versions.map((version) => (version.id === window.baseVersionId ? updated : version)),
    rehearsalWindow: {
      ...window,
      baseSnapshot: deepCopy(updated),
      draft: deepCopy(updated),
      queue: [],
      conflicts: [],
      writeState: 'succeeded',
      writeError: null
    }
  };
}

export const scriptReducer = createReducer(
  getInitialState(),
  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),
  on(activateVersion, (state, { id }) => {
    let rehearsalWindow = state.rehearsalWindow;
    // 来源或版本一变，冲突项失效退回并显示缺号
    if (rehearsalWindow && rehearsalWindow.baseVersionId !== id) {
      const queue = rehearsalWindow.queue.map((op) =>
        op.status === 'conflict' ? { ...op, status: 'missing-number' as OpStatus } : op
      );
      rehearsalWindow = { ...rehearsalWindow, queue, conflicts: [], writeState: 'idle' as WriteState, writeError: null };
    }
    return { ...state, activeVersionId: id, rehearsalWindow };
  }),
  on(reviewLine, (state, { id, decision }) => ({
    ...state,
    versions: state.versions.map((version) =>
      version.id !== state.activeVersionId
        ? version
        : {
            ...version,
            lines: version.lines.map((line) => (line.id === id ? { ...line, status: decision } : line))
          }
    )
  })),
  on(reorderLines, (state, { from, to }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== state.activeVersionId || from === to) return version;
      const lines = [...version.lines];
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    })
  })),
  on(reviewCue, (state, { id, decision }) => ({
    ...state,
    versions: state.versions.map((version) =>
      version.id !== state.activeVersionId
        ? version
        : {
            ...version,
            cues: version.cues.map((cue) => (cue.id === id ? { ...cue, status: decision } : cue))
          }
    )
  })),
  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => ({ ...state, online })),
  on(openRehearsalWindow, (state, { versionId }) => {
    const target = state.versions.find((version) => version.id === versionId);
    if (!target) return state;
    const result = migrateVersion(target);
    const versions = result.migrated
      ? state.versions.map((version) => (version.id === versionId ? result.version : version))
      : state.versions;
    return {
      ...state,
      versions,
      rehearsalWindow: {
        baseVersionId: versionId,
        baseSnapshot: deepCopy(result.version),
        draft: deepCopy(result.version),
        queue: [],
        conflicts: [],
        writeState: 'idle' as WriteState,
        writeError: null,
        migrated: result.migrated,
        migrationNotes: result.notes
      }
    };
  }),
  on(closeRehearsalWindow, (state) => ({ ...state, rehearsalWindow: null })),
  on(reviewLineDraft, (state, { lineId, decision, source }) => {
    const window = state.rehearsalWindow;
    if (!window) return state;
    const op: PendingOp = { id: nextOpId(), kind: 'reviewLine', source, status: 'pending', lineId, decision };
    const draft = {
      ...window.draft,
      lines: window.draft.lines.map((line) => (line.id === lineId ? { ...line, status: decision } : line))
    };
    return { ...state, rehearsalWindow: { ...window, draft, queue: [...window.queue, op] } };
  }),
  on(reorderLinesDraft, (state, { from, to, source }) => {
    const window = state.rehearsalWindow;
    if (!window) return state;
    const op: PendingOp = { id: nextOpId(), kind: 'reorderLines', source, status: 'pending', from, to };
    const lines = [...window.draft.lines];
    const [moved] = lines.splice(from, 1);
    lines.splice(to, 0, moved);
    return { ...state, rehearsalWindow: { ...window, draft: { ...window.draft, lines }, queue: [...window.queue, op] } };
  }),
  on(reviewCueDraft, (state, { cueId, decision, source }) => {
    const window = state.rehearsalWindow;
    if (!window) return state;
    const op: PendingOp = { id: nextOpId(), kind: 'reviewCue', source, status: 'pending', cueId, decision };
    const draft = {
      ...window.draft,
      cues: window.draft.cues.map((cue) => (cue.id === cueId ? { ...cue, status: decision } : cue))
    };
    return { ...state, rehearsalWindow: { ...window, draft, queue: [...window.queue, op] } };
  }),
  on(editCueTimingDraft, (state, { cueId, timing, source }) => {
    const window = state.rehearsalWindow;
    if (!window) return state;
    const op: PendingOp = { id: nextOpId(), kind: 'editCueTiming', source, status: 'pending', cueId, timing };
    const draft = {
      ...window.draft,
      cues: window.draft.cues.map((cue) => (cue.id === cueId ? { ...cue, timing } : cue))
    };
    return { ...state, rehearsalWindow: { ...window, draft, queue: [...window.queue, op] } };
  }),
  on(commitBatch, (state) => attemptCommit(state)),
  on(retryBatch, (state) => attemptCommit(state))
);

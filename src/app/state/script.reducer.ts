import { createReducer, on } from '@ngrx/store';
import {
  activateVersion, addVersion, beginCommit, changeCueTiming, commitFailed, commitSucceeded,
  discardOp, reorderLines, resolveConflict, reviewCue, reviewLine, setOnline,
  simulateSourceChange, toggleFailNextWrite, toggleRehearsal
} from './script.actions';
import {
  applyOps, EntryStatus, getVersion, migrateState, projectVersion,
  reevaluateOps, ScriptState, ScriptVersion, SyncOp
} from './script.models';

const seedVersions: ScriptVersion[] = [
  {
    id: 'v12', label: '排练稿 v12', playwright: '林编剧', note: '重写第三场父女冲突，舞台灯光提示延后2拍。',
    revision: 3, source: '编剧台本',
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending', fingerprint: 'lfp-seed-l1' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending', fingerprint: 'lfp-seed-l2' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', timing: '周岚开口前1拍', status: 'pending', fingerprint: 'cfp-seed-c1' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', timing: '周野第2句后', status: 'accepted', fingerprint: 'cfp-seed-c2' }
    ]
  },
  {
    id: 'v13', label: '导演修订 v13', playwright: '林编剧', note: '调整周岚结论，加入一次性追光变化。',
    revision: 1, source: '导演台本',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending', fingerprint: 'lfp-seed-l1b' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending', fingerprint: 'lfp-seed-l3' }
    ],
    cues: [{ id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', timing: '第3场开场', status: 'pending', fingerprint: 'cfp-seed-c3' }]
  }
];

function defaultState(): ScriptState {
  return {
    versions: seedVersions, activeVersionId: 'v12', rehearsalMode: false, online: true,
    pendingOps: [], sync: 'idle', syncError: null, failNextWrite: false, lastCommittedAt: null
  };
}

function getInitialState(): ScriptState {
  if (typeof localStorage === 'undefined') return defaultState();
  const saved = localStorage.getItem('yf52-script-state');
  if (!saved) return defaultState();
  try {
    const parsed = JSON.parse(saved) as Partial<ScriptState>;
    if (!Array.isArray(parsed.versions)) return defaultState();
    return migrateState({
      ...defaultState(),
      ...parsed,
      pendingOps: Array.isArray(parsed.pendingOps) ? parsed.pendingOps : [],
      sync: parsed.sync === 'error' ? 'error' : 'idle'
    } as ScriptState);
  } catch {
    return defaultState();
  }
}

let opSeq = 0;
function opId(prefix: string) {
  opSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${opSeq}`;
}

const decisionLabel: Record<EntryStatus, string> = { accepted: '采纳', returned: '退回', pending: '重置为待确认' };

/** 同类操作先替换未提交的旧操作，保证队列里每类改动只保留最新一版。 */
function enqueueOp(state: ScriptState, op: SyncOp, replace: (queued: SyncOp) => boolean): ScriptState {
  // 写出进行中队列已冻结：新改动不能混进正在落盘的整批。
  if (state.sync === 'writing') return state;
  const pendingOps = state.pendingOps
    .filter((existing) => !(existing.status === 'queued' && replace(existing)))
    .concat(op);
  return { ...state, pendingOps, syncError: null };
}

/** 以当前快照 + 队列投影出的窗口顺序，生成调换顺序操作。 */
function buildReorderOp(state: ScriptState, from: number, to: number): SyncOp | null {
  if (from === to) return null;
  const version = getVersion(state.versions, state.activeVersionId);
  const projected = projectVersion(state.versions, version.id, state.pendingOps);
  const order = projected.lines.map((line) => line.id);
  const movedRow = projected.lines[from];
  const [movedId] = order.splice(from, 1);
  order.splice(to, 0, movedId);
  const movedLabel = movedRow && !('ghost' in movedRow) ? movedRow.role : '台词';
  return {
    id: opId('op-reorder'), source: 'stage-manager',
    anchorVersionId: version.id, anchorRevision: version.revision,
    kind: 'reorder-lines', label: `舞台监督调换台词顺序：${movedLabel} 的台词移到第 ${to + 1} 位`,
    status: 'queued', createdAt: Date.now(), order
  };
}

/** 模拟来源侧改动：当前版本 revision +1，队列里锚定的操作立即重新评估。 */
function mutateSource(state: ScriptState, scope: 'line' | 'cue-timing' | 'line-remove' | 'reorder'): ScriptState {
  const versions = state.versions.map((version): ScriptVersion => {
    if (version.id !== state.activeVersionId) return version;
    const bumped = { ...version, revision: version.revision + 1 };
    if (scope === 'line' && version.lines[0]) {
      const first = version.lines[0];
      bumped.lines = [
        { ...first, text: `${first.text}（来源侧改写）`, fingerprint: `${first.fingerprint}#r${bumped.revision}` },
        ...version.lines.slice(1)
      ];
    } else if (scope === 'cue-timing' && version.cues[0]) {
      const first = version.cues[0];
      bumped.cues = [
        { ...first, timing: `来源改为：第${bumped.revision}拍执行`, fingerprint: `${first.fingerprint}#r${bumped.revision}` },
        ...version.cues.slice(1)
      ];
    } else if (scope === 'line-remove') {
      bumped.lines = version.lines.slice(1);
    } else if (scope === 'reorder' && version.lines.length > 1) {
      bumped.lines = [...version.lines.slice(1), version.lines[0]];
    }
    return bumped;
  });
  return {
    ...state, versions,
    pendingOps: reevaluateOps(state.pendingOps, versions, state.activeVersionId)
  };
}

/** 重新从 localStorage 读取初始状态（供持久化迁移等场景与测试使用）。 */
export function loadInitialScriptState(): ScriptState {
  return getInitialState();
}

export const scriptReducer = createReducer(
  getInitialState(),

  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),

  // 切换版本：锚定在旧版本上的待同步操作立即失效退回。
  on(activateVersion, (state, { id }) => {
    if (id === state.activeVersionId) return state;
    return {
      ...state, activeVersionId: id,
      pendingOps: reevaluateOps(state.pendingOps, state.versions, id)
    };
  }),

  on(reviewLine, (state, { id, decision }) => {
    const version = getVersion(state.versions, state.activeVersionId);
    const line = version.lines.find((item) => item.id === id);
    if (!line) return state;
    // 与正式快照一致：没有需要同步的改动，撤回已有同类排队操作即可。
    if (line.status === decision) {
      return {
        ...state,
        pendingOps: state.pendingOps.filter((op) =>
          !(op.status === 'queued' && op.anchorVersionId === version.id &&
            op.kind === 'review-line' && op.entryId === id))
      };
    }
    const op: SyncOp = {
      id: opId('op-line'), source: 'stage-manager',
      anchorVersionId: version.id, anchorRevision: version.revision,
      kind: 'review-line', label: `舞台监督${decisionLabel[decision]}台词：${line.role}「${line.text.slice(0, 14)}」`,
      status: 'queued', createdAt: Date.now(), entryId: id, decision, baseText: line.text
    };
    return enqueueOp(state, op, (existing) =>
      existing.anchorVersionId === version.id && existing.kind === 'review-line' && existing.entryId === id);
  }),

  on(reorderLines, (state, { from, to }) => {
    const op = buildReorderOp(state, from, to);
    if (!op) return state;
    return enqueueOp(state, op, (existing) =>
      existing.anchorVersionId === state.activeVersionId && existing.kind === 'reorder-lines');
  }),

  on(reviewCue, (state, { id, decision }) => {
    const version = getVersion(state.versions, state.activeVersionId);
    const cue = version.cues.find((item) => item.id === id);
    if (!cue) return state;
    if (cue.status === decision) {
      return {
        ...state,
        pendingOps: state.pendingOps.filter((op) =>
          !(op.status === 'queued' && op.anchorVersionId === version.id &&
            op.kind === 'review-cue' && op.entryId === id))
      };
    }
    const op: SyncOp = {
      id: opId('op-cue'), source: 'stage-manager',
      anchorVersionId: version.id, anchorRevision: version.revision,
      kind: 'review-cue', label: `舞台监督${decisionLabel[decision]}提示：${cue.scene}「${cue.text.slice(0, 14)}」`,
      status: 'queued', createdAt: Date.now(), entryId: id, decision, baseText: cue.text
    };
    return enqueueOp(state, op, (existing) =>
      existing.anchorVersionId === version.id && existing.kind === 'review-cue' && existing.entryId === id);
  }),

  on(changeCueTiming, (state, { id, timing }) => {
    const version = getVersion(state.versions, state.activeVersionId);
    const cue = version.cues.find((item) => item.id === id);
    if (!cue) return state;
    // 计时改回快照值：待同步操作消失，不留空队列项。
    if (timing === cue.timing) {
      return {
        ...state,
        pendingOps: state.pendingOps.filter((op) =>
          !(op.status === 'queued' && op.anchorVersionId === version.id &&
            op.kind === 'cue-timing' && op.entryId === id))
      };
    }
    const op: SyncOp = {
      id: opId('op-timing'), source: 'director',
      anchorVersionId: version.id, anchorRevision: version.revision,
      kind: 'cue-timing',
      label: `导演调整提示计时：${cue.scene} ${cue.timing || '（无计时）'} → ${timing || '（清除计时）'}`,
      status: 'queued', createdAt: Date.now(), entryId: id, timing, baseTiming: cue.timing
    };
    return enqueueOp(state, op, (existing) =>
      existing.anchorVersionId === version.id && existing.kind === 'cue-timing' && existing.entryId === id);
  }),

  on(discardOp, (state, { opId: id }) => {
    // 写出进行中队列已锁定，不允许改动，保证「整批」语义。
    if (state.sync === 'writing') return state;
    return { ...state, pendingOps: state.pendingOps.filter((op) => op.id !== id) };
  }),

  on(resolveConflict, (state, { opId: id, way }) => {
    if (state.sync === 'writing') return state;
    if (way === 'discard') {
      return { ...state, pendingOps: state.pendingOps.filter((op) => op.id !== id) };
    }
    const pendingOps = state.pendingOps.map((op) => {
      if (op.id !== id || op.status !== 'conflict' || !op.conflict) return op;
      if (way === 'theirs') {
        // 采纳来源版本：操作作废退回，窗口直接显示来源的新内容。
        return { ...op, status: 'invalid' as const, conflict: { ...op.conflict!, resolved: 'theirs' as const } };
      }
      // 保留我的改动：重锚到最新 revision 与最新基线，回到待提交队列。
      const version = getVersion(state.versions, op.anchorVersionId);
      const line = version.lines.find((item) => item.id === op.entryId);
      const cue = version.cues.find((item) => item.id === op.entryId);
      return {
        ...op, status: 'queued' as const, anchorRevision: version.revision,
        baseText: line?.text ?? op.baseText,
        baseTiming: cue ? cue.timing : op.baseTiming,
        conflict: { ...op.conflict!, resolved: 'mine' as const }
      };
    });
    return { ...state, pendingOps };
  }),

  on(beginCommit, (state) => state.sync === 'writing' ? state : { ...state, sync: 'writing' as const, syncError: null }),

  // 整批写出成功：一次性把全部 queued 操作应用到快照，再清空这批操作。
  on(commitSucceeded, (state) => {
    const byVersion = new Map<string, SyncOp[]>();
    for (const op of state.pendingOps) {
      if (op.status !== 'queued') continue;
      byVersion.set(op.anchorVersionId, [...(byVersion.get(op.anchorVersionId) ?? []), op]);
    }
    const versions = state.versions.map((version) =>
      byVersion.has(version.id) ? applyOps(version, byVersion.get(version.id)!) : version);
    // 已提交的操作移除；冲突 / 失效项保留，继续按来源列清给人处理。
    const committed = new Set<string>();
    for (const ops of byVersion.values()) ops.forEach((op) => committed.add(op.id));
    return {
      ...state, versions, sync: 'idle' as const, syncError: null,
      pendingOps: state.pendingOps.filter((op) => !committed.has(op.id)),
      failNextWrite: false, lastCommittedAt: Date.now()
    };
  }),

  // 写出失败：队列原样保留（状态、锚定都不动），可整批重试。
  on(commitFailed, (state, { reason }) => ({ ...state, sync: 'error' as const, syncError: reason })),

  on(toggleFailNextWrite, (state) => ({ ...state, failNextWrite: !state.failNextWrite })),

  on(simulateSourceChange, (state, { scope }) => mutateSource(state, scope)),

  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => ({ ...state, online }))
);

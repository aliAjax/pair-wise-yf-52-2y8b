import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoModule } from '@jsverse/transloco';
import { Store } from '@ngrx/store';
import { Subscription } from 'rxjs';
import {
  activateVersion, addVersion, beginCommit, changeCueTiming, commitFailed, commitSucceeded,
  discardOp, reorderLines, resolveConflict, reviewCue, reviewLine, setOnline,
  simulateSourceChange, toggleFailNextWrite, toggleRehearsal
} from './state/script.actions';
import {
  isGhost, opSourceLabel, ProjectedVersion, projectVersion, ScriptState,
  ScriptVersion, SyncOp
} from './state/script.models';

interface QueueGroups {
  queued: SyncOp[];
  conflicts: SyncOp[];
  invalid: SyncOp[];
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DragDropModule, MatToolbarModule, MatButtonModule, MatCardModule,
    MatTabsModule, MatIconModule, MatFormFieldModule, MatInputModule, MatProgressBarModule,
    MatDividerModule, MatBadgeModule, MatTooltipModule, TranslocoModule
  ],
  template: `
    <mat-toolbar color="primary" class="topbar">
      <span>{{ 'title' | transloco }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="toggleOnline()">
        <mat-icon>{{ state.online ? 'cloud' : 'cloud_off' }}</mat-icon>
        {{ state.online ? '在线' : '离线缓存中' }}
      </button>
      <button mat-flat-button color="accent" (click)="toggleRehearsal()">
        <mat-icon>{{ state.rehearsalMode ? 'edit_off' : 'face' }}</mat-icon>
        {{ state.rehearsalMode ? '返回编辑窗口' : '排练提词模式' }}
      </button>
    </mat-toolbar>

    <main [class.rehearsal]="state.rehearsalMode" *ngIf="projected as p">
      <!-- 版本与来源 -->
      <section class="summary">
        <mat-card>
          <mat-card-title>版本控制 · 来源快照</mat-card-title>
          <p>窗口改动先记入待同步队列，整批写出成功后才替换正式快照；排练模式只读取已确认快照。</p>
          <div class="chips">
            <button mat-stroked-button *ngFor="let version of state.versions"
                    [color]="version.id === state.activeVersionId ? 'primary' : ''"
                    (click)="activate(version.id)">
              {{ version.label }} · {{ version.playwright }}
              <span class="rev">r{{ version.revision }} · {{ version.source }}</span>
            </button>
            <button mat-flat-button color="primary" (click)="createDraft()">新增本地修订</button>
          </div>
        </mat-card>
      </section>

      <div class="workspace">
        <!-- 排练窗口（编辑视图 / 提词视图） -->
        <mat-card class="script">
          <mat-card-title>
            {{ p.version.label }}
            <span class="snapshot-tag">已确认快照 r{{ p.version.revision }} · 来源：{{ p.version.source }}</span>
          </mat-card-title>
          <mat-card-subtitle>{{ p.version.note }}</mat-card-subtitle>

          <div class="rehearsal-banner" *ngIf="state.rehearsalMode">
            <mat-icon>lock</mat-icon>
            排练提词模式只读：仅显示已采纳（accepted）条目；待确认、待同步与冲突内容都不会混入。
          </div>

          <mat-tab-group>
            <mat-tab>
              <ng-template mat-tab-label>角色台词 <span class="count">{{ lineView.length }}</span></ng-template>
              <div cdkDropList
                   [cdkDropListDisabled]="state.rehearsalMode || state.sync === 'writing'"
                   (cdkDropListDropped)="dropLine($event)">
                <article class="line" cdkDrag [class.accepted]="!isGhostRow(row) && row.status === 'accepted'"
                         *ngFor="let row of lineView">
                  <ng-container *ngIf="!isGhostRow(row)">
                    <div class="line-body">
                      <div class="line-head">
                        <b>{{ row.role }}</b>
                        <span class="seq-no">#{{ row.id }}</span>
                        <span class="migrated" *ngIf="row.migrated"
                              matTooltip="旧数据缺条目编号，已按文本指纹补号并标记迁移">迁移补号</span>
                        <span class="dirty" *ngIf="row.dirty">待同步：{{ row.pendingDecision }}</span>
                      </div>
                      <p>{{ row.text }}</p>
                      <div class="status-row">
                        <span class="status" [class.ok]="row.status === 'accepted'" [class.back]="row.status === 'returned'">
                          快照状态：{{ statusText(row.status) }}
                        </span>
                      </div>
                    </div>
                    <div class="actions" *ngIf="!state.rehearsalMode">
                      <mat-icon class="drag-handle">drag_indicator</mat-icon>
                      <button mat-button color="primary" (click)="reviewLine(row.id, 'accepted')">采纳</button>
                      <button mat-button color="warn" (click)="reviewLine(row.id, 'returned')">退回</button>
                    </div>
                  </ng-container>
                  <ng-container *ngIf="isGhostRow(row)">
                    <div class="ghost">
                      <mat-icon>question_mark</mat-icon>
                      <div>
                        <b>{{ row.label }}</b>
                        <p>{{ row.reason }}（来源或版本变化后锚定条目缺失，无法静默补回）</p>
                      </div>
                    </div>
                  </ng-container>
                </article>
              </div>
            </mat-tab>

            <mat-tab>
              <ng-template mat-tab-label>舞台提示 <span class="count">{{ cueView.length }}</span></ng-template>
              <article class="line" *ngFor="let cue of cueView">
                <div class="line-body">
                  <div class="line-head">
                    <b>{{ cue.scene }}</b>
                    <span class="seq-no">#{{ cue.id }}</span>
                    <span class="migrated" *ngIf="cue.migrated">迁移补号</span>
                    <span class="dirty" *ngIf="cue.dirty">
                      待同步<span *ngIf="cue.pendingDecision">：{{ cue.pendingDecision }}</span>
                    </span>
                  </div>
                  <p>{{ cue.text }}</p>
                  <div class="timing" *ngIf="!state.rehearsalMode">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic">
                      <mat-label>导演改提示计时</mat-label>
                      <input matInput [ngModel]="cue.pendingTiming !== undefined ? cue.pendingTiming : cue.timing"
                             (ngModelChange)="changeTiming(cue.id, $event)"
                             [disabled]="state.sync === 'writing'">
                    </mat-form-field>
                    <span class="timing-base" *ngIf="cue.pendingTiming !== undefined && cue.pendingTiming !== cue.timing">
                      快照计时：{{ cue.timing || '（无计时）' }}
                    </span>
                  </div>
                  <div class="timing readonly" *ngIf="state.rehearsalMode">
                    <span class="timing-tag">计时：{{ cue.timing || '（无计时）' }}</span>
                  </div>
                  <div class="status-row">
                    <span class="status" [class.ok]="cue.status === 'accepted'" [class.back]="cue.status === 'returned'">
                      快照状态：{{ statusText(cue.status) }}
                    </span>
                  </div>
                </div>
                <div class="actions vertical" *ngIf="!state.rehearsalMode">
                  <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                  <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                </div>
              </article>
            </mat-tab>
          </mat-tab-group>
        </mat-card>

        <!-- 右栏：待同步队列 / 对比 / 联调 -->
        <aside>
          <mat-card class="queue">
            <mat-card-title>
              待同步操作
              <span [matBadge]="groups.queued.length" matBadgeColor="accent"
                    [matBadgeHidden]="groups.queued.length === 0">&nbsp;</span>
            </mat-card-title>

            <div class="commit-box">
              <button mat-flat-button color="primary" class="commit-btn"
                      [disabled]="groups.queued.length === 0 || state.sync === 'writing'"
                      (click)="commit()">
                <mat-icon>sync</mat-icon>
                整批写出（{{ groups.queued.length }} 项）
              </button>
              <mat-progress-bar *ngIf="state.sync === 'writing'" mode="indeterminate"></mat-progress-bar>
              <p class="commit-hint" *ngIf="groups.conflicts.length + groups.invalid.length > 0">
                冲突 {{ groups.conflicts.length }} 项、失效 {{ groups.invalid.length }} 项
                不参与本次写出，需先按来源逐条处理。
              </p>
              <div class="write-failed" *ngIf="state.sync === 'error'">
                <mat-icon>error_outline</mat-icon>
                <div>
                  <b>整批写出失败，队列已原样保留</b>
                  <p>{{ state.syncError }}</p>
                  <button mat-stroked-button color="warn" (click)="commit()">重试整批写出</button>
                </div>
              </div>
              <p class="committed" *ngIf="state.lastCommittedAt as ts">上次成功替换快照：{{ ts | date:'HH:mm:ss' }}</p>
            </div>

            <ng-container *ngIf="groups.queued.length > 0">
              <h4>待写出（窗口记住的改动版本）</h4>
              <div class="op queued" *ngFor="let op of groups.queued">
                <div class="op-main">
                  <span class="op-source" [class.director]="op.source === 'director'">{{ sourceLabel(op.source) }}</span>
                  <span>{{ op.label }}</span>
                </div>
                <button mat-icon-button (click)="discard(op.id)" matTooltip="撤回该操作"><mat-icon>close</mat-icon></button>
              </div>
            </ng-container>

            <ng-container *ngIf="groups.conflicts.length > 0">
              <mat-divider></mat-divider>
              <h4 class="conflict-heading">冲突 · 按来源列清（不会静默覆盖）</h4>
              <div class="op conflict" *ngFor="let op of groups.conflicts">
                <div class="op-main">
                  <div class="op-line"><span class="op-source clash">{{ sourceLabel(op.source) }}</span><b>{{ op.label }}</b></div>
                  <div class="conflict-detail">
                    <span class="kv">对方来源：{{ op.conflict?.source }}</span>
                    <span class="kv">你的基线：r{{ op.conflict?.baseRevision }}</span>
                    <span class="kv">冲突类型：{{ conflictKindText(op.conflict?.kind) }}</span>
                    <span class="kv theirs">对方内容：{{ op.conflict?.theirs }}</span>
                  </div>
                  <div class="resolve-row" *ngIf="op.kind !== 'reorder-lines'">
                    <button mat-stroked-button color="primary" (click)="resolve(op.id, 'mine')">保留我的</button>
                    <button mat-stroked-button (click)="resolve(op.id, 'theirs')">采用来源</button>
                    <button mat-button color="warn" (click)="resolve(op.id, 'discard')">丢弃</button>
                  </div>
                  <div class="resolve-row" *ngIf="op.kind === 'reorder-lines'">
                    <button mat-stroked-button color="primary" (click)="resolve(op.id, 'mine')">仍按我的顺序重锚</button>
                    <button mat-button color="warn" (click)="resolve(op.id, 'discard')">放弃排序改动</button>
                  </div>
                </div>
              </div>
            </ng-container>

            <ng-container *ngIf="groups.invalid.length > 0">
              <mat-divider></mat-divider>
              <h4 class="invalid-heading">失效退回 · 缺号</h4>
              <div class="op invalid" *ngFor="let op of groups.invalid">
                <mat-icon>link_off</mat-icon>
                <div class="op-main">
                  <b>{{ op.label }}</b>
                  <span class="kv">锚定版本 {{ op.anchorVersionId }}@r{{ op.anchorRevision }} 已不是当前来源 / 版本</span>
                  <span class="kv theirs" *ngIf="op.conflict?.resolved === 'theirs'">已采用来源版本，该操作退回</span>
                </div>
              </div>
            </ng-container>

            <p class="empty" *ngIf="totalOps === 0">队列空。采纳、退回、排序、改计时都会在此生成待同步操作。</p>
          </mat-card>

          <mat-card class="compare">
            <mat-card-title>版本对比（基准 v12）</mat-card-title>
            <p class="version-name">{{ p.version.id === 'v12' ? '当前即基准' : '基准 v12 → ' + p.version.label }}</p>
            <div class="diff"><b>台词</b><span>{{ p.version.lines.length }} 条（已确认快照）</span></div>
            <div class="diff"><b>舞台提示</b><span>{{ p.version.cues.length }} 条</span></div>
            <div class="diff"><b>迁移补号</b>
              <span>{{ migrationCount(p.version) }} 项（旧数据缺条目编号，按文本指纹补号）</span>
            </div>
          </mat-card>

          <mat-card class="harness">
            <mat-card-title>同步与来源联调</mat-card-title>
            <p class="hint">模拟断网、写出失败，以及来源端（编剧/导演台本）在你排队期间推来改动。</p>
            <div class="harness-row">
              <button mat-stroked-button (click)="toggleOnline()">{{ state.online ? '切到离线' : '恢复在线' }}</button>
              <button mat-stroked-button [color]="state.failNextWrite ? 'warn' : ''" (click)="toggleFailNextWrite()">
                {{ state.failNextWrite ? '✓ 下次写出将失败' : '制造写出失败' }}
              </button>
            </div>
            <mat-divider></mat-divider>
            <p class="hint">来源或版本一变，队列立即重新评估：</p>
            <div class="harness-row wrap">
              <button mat-stroked-button (click)="sourceChange('line')">来源改写首条台词</button>
              <button mat-stroked-button (click)="sourceChange('cue-timing')">来源改首个提示计时</button>
              <button mat-stroked-button (click)="sourceChange('line-remove')">来源删除首条台词（缺号）</button>
              <button mat-stroked-button (click)="sourceChange('reorder')">来源调整台词顺序</button>
            </div>
          </mat-card>
        </aside>
      </div>
    </main>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; gap: 10px; }
    .topbar button { margin-left: 8px; }
    .spacer { flex: 1; }
    main { max-width: 1280px; margin: 0 auto; padding: 18px 18px 64px; }
    .summary { margin-bottom: 16px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
    .rev { color: #6b7280; font-size: 12px; margin-left: 4px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr); gap: 16px; align-items: start; }
    aside { display: flex; flex-direction: column; gap: 16px; }
    .snapshot-tag { font-size: 12px; font-weight: 400; color: #6b7280; margin-left: 10px; }
    .rehearsal-banner { display: flex; gap: 8px; align-items: center; background: #1f2937; color: #fde68a;
      padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 12px; }
    .count { font-size: 12px; color: #6b7280; margin-left: 2px; }
    .line { display: flex; justify-content: space-between; gap: 16px; align-items: center;
      padding: 14px 4px; border-bottom: 1px solid #e5e7eb; }
    .line.accepted .line-body p { color: #14532d; }
    .line-body { flex: 1; min-width: 0; }
    .line-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.7; }
    .seq-no { font-size: 12px; color: #9ca3af; font-family: monospace; }
    .migrated { font-size: 11px; color: #92400e; background: #fef3c7; border-radius: 6px; padding: 1px 8px; }
    .dirty { font-size: 12px; color: #1d4ed8; background: #dbeafe; border-radius: 6px; padding: 1px 8px; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .status.back { color: #b91c1c; }
    .actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .actions.vertical { flex-direction: column; }
    .drag-handle { cursor: grab; color: #9ca3af; }
    .timing { display: flex; align-items: center; gap: 12px; margin: 6px 0; }
    .timing mat-form-field { width: 280px; }
    .timing.readonly .timing-tag { font-size: 14px; }
    .timing-base { font-size: 12px; color: #6b7280; }
    .ghost { display: flex; gap: 12px; align-items: flex-start; color: #b91c1c; background: #fef2f2;
      border: 1px dashed #fca5a5; border-radius: 8px; padding: 12px; width: 100%; }
    .ghost p { margin: 4px 0 0; font-size: 13px; color: #991b1b; }
    .queue h4 { margin: 14px 0 8px; font-size: 14px; }
    .op { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start;
      border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: #fff; }
    .op-main { display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 1.5; }
    .op-line { display: flex; gap: 8px; align-items: baseline; }
    .op-source { font-size: 11px; background: #ede9fe; color: #5b21b6; border-radius: 6px; padding: 1px 8px; flex-shrink: 0; }
    .op-source.director { background: #e0f2fe; color: #075985; }
    .op-source.clash { background: #fee2e2; color: #991b1b; }
    .op.conflict { border-color: #fca5a5; background: #fff7f7; }
    .op.invalid { border-color: #d1d5db; background: #f9fafb; color: #6b7280; }
    .op.invalid .op-main b { color: #4b5563; }
    .conflict-heading { color: #b91c1c; }
    .invalid-heading { color: #6b7280; }
    .conflict-detail { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
    .kv { color: #6b7280; }
    .kv.theirs { color: #991b1b; }
    .resolve-row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .commit-box { margin: 10px 0 4px; }
    .commit-btn { width: 100%; }
    .commit-hint { font-size: 12px; color: #b45309; margin: 8px 0 0; }
    .write-failed { display: flex; gap: 10px; align-items: flex-start; margin-top: 10px;
      background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 10px 12px; color: #991b1b; }
    .write-failed p { margin: 2px 0 8px; font-size: 12px; }
    .committed { font-size: 12px; color: #15803d; margin: 8px 0 0; }
    .empty { font-size: 13px; color: #9ca3af; padding: 8px 0; }
    .diff { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid #e5e7eb; padding: 12px 0; font-size: 13px; }
    .version-name { padding: 10px 12px; background: #f3f4f6; border-radius: 8px; font-size: 13px; }
    .harness-row { display: flex; gap: 8px; margin: 8px 0; }
    .harness-row.wrap { flex-wrap: wrap; }
    .hint { font-size: 12px; color: #6b7280; margin: 6px 0; }

    /* 排练提词模式：只读取已确认快照，大字号；隐藏队列与联调面板 */
    main.rehearsal { max-width: 920px; background: #0f172a; min-height: 100vh; color: #f8fafc; }
    main.rehearsal .script, main.rehearsal .compare, main.rehearsal .summary { background: #1e293b; color: #f8fafc; }
    main.rehearsal .line { border-bottom-color: #334155; }
    main.rehearsal .line p { font-size: 30px; line-height: 1.7; margin: 14px 0; letter-spacing: 1px; }
    main.rehearsal .line-head b { font-size: 20px; color: #fbbf24; }
    main.rehearsal .status, main.rehearsal .seq-no, main.rehearsal .snapshot-tag { color: #94a3b8; }
    main.rehearsal .queue, main.rehearsal .harness { display: none; }
    @media (max-width: 900px) { .workspace { grid-template-columns: 1fr; } }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  /** 每次状态变化同步刷新的视图模型；NgRx 派发是同步的，模板始终读到最新值。 */
  state: ScriptState = {
    versions: [], activeVersionId: '', rehearsalMode: false, online: true,
    pendingOps: [], sync: 'idle', syncError: null, failNextWrite: false, lastCommittedAt: null
  };
  projected!: ProjectedVersion;
  lineView: ProjectedVersion['lines'] = [];
  cueView: ProjectedVersion['cues'] = [];
  groups: QueueGroups = { queued: [], conflicts: [], invalid: [] };

  private stateSub?: Subscription;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: navigator.onLine }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.stateSub = this.store.select('script').subscribe((state) => {
      this.state = state;
      // 排练模式只读取已确认快照：窗口投影（含待同步改动）不参与渲染。
      this.projected = state.rehearsalMode
        ? {
            version: state.versions.find((v) => v.id === state.activeVersionId) ?? state.versions[0],
            lines: (state.versions.find((v) => v.id === state.activeVersionId) ?? state.versions[0]).lines.map((l) => ({ ...l })),
            cues: (state.versions.find((v) => v.id === state.activeVersionId) ?? state.versions[0]).cues.map((c) => ({ ...c }))
          }
        : projectVersion(state.versions, state.activeVersionId, state.pendingOps);
      this.lineView = state.rehearsalMode
        ? this.projected.lines.filter((row) => !isGhost(row) && row.status === 'accepted')
        : this.projected.lines;
      this.cueView = state.rehearsalMode
        ? this.projected.cues.filter((cue) => cue.status === 'accepted')
        : this.projected.cues;
      const local = state.pendingOps.filter((op) => op.anchorVersionId === this.projected.version.id);
      this.groups = {
        queued: local.filter((op) => op.status === 'queued'),
        conflicts: local.filter((op) => op.status === 'conflict'),
        invalid: local.filter((op) => op.status === 'invalid')
      };
      localStorage.setItem('yf52-script-state', JSON.stringify(state));
    });
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.stateSub?.unsubscribe();
  }

  isGhostRow = isGhost;
  sourceLabel = opSourceLabel;

  get totalOps() {
    return this.groups.queued.length + this.groups.conflicts.length + this.groups.invalid.length;
  }

  statusText(status: string) {
    return { accepted: '已采纳', returned: '已退回', pending: '待确认' }[status] ?? status;
  }
  conflictKindText(kind?: string) {
    return {
      text: '台词文本冲突', timing: '提示计时冲突', reorder: '排序冲突',
      missing: '缺号 / 条目缺失', revision: '来源版本已更新'
    }[kind ?? ''] ?? kind;
  }
  migrationCount(version: ScriptVersion) {
    return version.lines.filter((l) => l.migrated).length + version.cues.filter((c) => c.migrated).length;
  }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  toggleOnline() { this.store.dispatch(setOnline({ online: !this.state.online })); }
  toggleFailNextWrite() { this.store.dispatch(toggleFailNextWrite()); }
  sourceChange(scope: 'line' | 'cue-timing' | 'line-remove' | 'reorder') {
    this.store.dispatch(simulateSourceChange({ scope }));
  }

  reviewLine(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewLine({ id, decision })); }
  reviewCue(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewCue({ id, decision })); }
  changeTiming(id: string, timing: string) { this.store.dispatch(changeCueTiming({ id, timing })); }
  discard(opId: string) { this.store.dispatch(discardOp({ opId })); }
  resolve(opId: string, way: 'theirs' | 'mine' | 'discard') { this.store.dispatch(resolveConflict({ opId, way })); }

  dropLine(event: CdkDragDrop<unknown>) {
    if (event.previousIndex !== event.currentIndex) {
      this.store.dispatch(reorderLines({ from: event.previousIndex, to: event.currentIndex }));
    }
  }

  /** 整批写出：成功才替换快照；失败保留队列，可重试。离线时写出直接失败、队列不动。 */
  commit() {
    if (this.state.sync === 'writing') return;
    if (!this.state.online) {
      this.store.dispatch(commitFailed({ reason: '当前处于离线状态，无法写出到正式快照；队列保留在本地缓存，恢复在线后可重试。' }));
      return;
    }
    const fail = this.state.failNextWrite;
    this.store.dispatch(beginCommit());
    setTimeout(() => {
      this.store.dispatch(fail
        ? commitFailed({ reason: '远端台本服务 503：本批次未落盘，队列保持不变，可重试。' })
        : commitSucceeded());
    }, 700);
  }

  createDraft() {
    const id = `v${Date.now().toString().slice(-5)}`;
    const version: ScriptVersion = {
      id, label: `本地修订 ${id}`, playwright: '本地草稿', source: '离线草稿', revision: 0,
      note: '断网期间创建的修订，待同步队列写出成功后才进入正式快照。',
      lines: [{ id: `${id}-l1`, role: '周岚', text: '这次换你告诉我，灯亮之后准备去哪里。', status: 'pending', fingerprint: `lfp-${id}-l1` }],
      cues: [{ id: `${id}-c1`, scene: '第三场', text: '追光保持到台词结束，再执行全场收光', timing: '末句后2拍', status: 'pending', fingerprint: `cfp-${id}-c1` }]
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
  }
}

import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import {
  closeRehearsalWindow,
  commitBatch,
  editCueTimingDraft,
  reorderLinesDraft,
  retryBatch,
  reviewCueDraft,
  reviewLineDraft
} from '../state/script.actions';
import { ConflictItem, PendingOp, RehearsalWindow, ScriptState } from '../state/script.reducer';

interface ConflictGroup {
  source: string;
  items: ConflictItem[];
}

@Component({
  selector: 'app-rehearsal-window',
  standalone: true,
  imports: [
    CommonModule,
    DragDropModule,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatIconModule,
    MatInputModule,
    MatTabsModule,
    TranslocoModule
  ],
  template: `
    <mat-card class="window">
      <mat-card-header>
        <mat-card-title>排练窗口 · 同时编辑台词与提示</mat-card-title>
        <mat-card-subtitle>
          记住的版本：{{ window.baseSnapshot.label }} · 来源：{{ window.baseSnapshot.source }}
          <span class="migrated" *ngIf="window.migrated">已按文本指纹补号并标记迁移</span>
        </mat-card-subtitle>
      </mat-card-header>

      <mat-tab-group>
        <mat-tab label="角色台词">
          <div cdkDropList (cdkDropListDropped)="dropLine($event)">
            <article class="line" cdkDrag *ngFor="let line of window.draft.lines">
              <div class="line-body">
                <b>{{ line.role }}</b>
                <p>{{ line.text }}</p>
                <span class="status" [class.ok]="line.status === 'accepted'">{{ line.status }}</span>
              </div>
              <div class="line-ops">
                <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                <mat-icon cdkDragHandle class="drag-handle">drag_indicator</mat-icon>
              </div>
            </article>
          </div>
        </mat-tab>
        <mat-tab label="舞台提示">
          <article class="line" *ngFor="let cue of window.draft.cues">
            <div class="line-body">
              <b>{{ cue.scene }}</b>
              <p>{{ cue.text }}</p>
              <span class="timing">计时：{{ cue.timing || '未设置' }}</span>
              <span class="status" [class.ok]="cue.status === 'accepted'">{{ cue.status }}</span>
            </div>
            <div class="line-ops">
              <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
              <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
              <input matInput type="text" class="timing-input" [value]="cue.timing" (change)="editTiming(cue.id, $event)" placeholder="计时，如 2拍" />
            </div>
          </article>
        </mat-tab>
      </mat-tab-group>

      <section class="queue">
        <h3>待同步操作（{{ window.queue.length }}）</h3>
        <p class="hint">采纳、退回、排序和提示改动都在此排队，整批写出成功后才替换正式快照。</p>
        <ul *ngIf="window.queue.length; else emptyQueue">
          <li *ngFor="let op of window.queue" class="op" [class]="op.status">
            <span class="source">{{ op.source }}</span>
            <span class="kind">{{ opKindLabel(op) }}</span>
            <span class="op-status">{{ opStatusLabel(op.status) }}</span>
          </li>
        </ul>
        <ng-template #emptyQueue><p class="hint">暂无待同步操作。</p></ng-template>
      </section>

      <section class="conflicts" *ngIf="window.conflicts.length">
        <h3>冲突（按来源列清，不会静默覆盖）</h3>
        <div *ngFor="let group of conflictGroups()" class="conflict-group">
          <h4>{{ group.source }}</h4>
          <ul>
            <li *ngFor="let item of group.items">{{ item.description }}</li>
          </ul>
        </div>
      </section>

      <section class="migration" *ngIf="window.migrated">
        <h3>迁移补号</h3>
        <ul>
          <li *ngFor="let note of window.migrationNotes">{{ note }}</li>
        </ul>
      </section>

      <div class="actions">
        <button
          mat-flat-button
          color="primary"
          (click)="commit()"
          [disabled]="!window.queue.length || window.writeState === 'writing'"
        >整批写出</button>
        <button mat-stroked-button color="warn" (click)="retry()" *ngIf="window.writeState === 'failed'">重试</button>
        <button mat-button (click)="close()">关闭窗口</button>
        <span class="write-state">{{ writeStateLabel(window.writeState) }}</span>
        <span class="offline-hint" *ngIf="!online">离线：写出将保留在队列中，恢复网络后可重试</span>
      </div>
      <p class="write-error" *ngIf="window.writeError">{{ window.writeError }}</p>
    </mat-card>
  `,
  styles: [`
    .window { margin: 18px 0; }
    .migrated { margin-left: 8px; font-size: 12px; color: #b45309; }
    .line { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .line-body { flex: 1; min-width: 0; }
    .line-body p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .line-ops { display: flex; align-items: center; gap: 8px; }
    .drag-handle { cursor: grab; color: #9ca3af; }
    .timing { display: inline-block; margin-right: 10px; font-size: 13px; color: #2563eb; }
    .timing-input { width: 120px; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .queue, .conflicts, .migration { margin-top: 18px; }
    .queue h3, .conflicts h3, .migration h3 { margin: 0 0 6px; font-size: 15px; }
    .hint { font-size: 13px; color: #6b7280; margin: 4px 0; }
    .queue ul, .conflicts ul { list-style: none; margin: 8px 0 0; padding: 0; }
    .queue li.op { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
    .queue li.op.conflict { background: #fef3c7; }
    .queue li.op.missing-number { background: #fee2e2; }
    .source { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #e0e7ff; color: #3730a3; }
    .kind { flex: 1; }
    .op-status { font-size: 12px; color: #b45309; }
    .op-status.ok { color: #15803d; }
    .conflict-group { margin-top: 8px; padding: 10px 12px; background: #fffbeb; border-radius: 8px; }
    .conflict-group h4 { margin: 0 0 4px; font-size: 14px; color: #b45309; }
    .conflict-group ul { margin: 0; padding-left: 18px; font-size: 13px; color: #78350f; }
    .migration ul { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: #6b7280; }
    .actions { display: flex; gap: 10px; align-items: center; margin-top: 18px; flex-wrap: wrap; }
    .write-state { font-size: 13px; color: #6b7280; }
    .offline-hint { font-size: 12px; color: #b45309; }
    .write-error { margin: 8px 0 0; font-size: 13px; color: #b91c1c; }
  `]
})
export class RehearsalWindowComponent {
  @Input({ required: true }) window!: RehearsalWindow;
  @Input({ required: true }) online!: boolean;

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  dropLine(event: CdkDragDrop<unknown>) {
    if (event.previousIndex !== event.currentIndex) {
      this.store.dispatch(reorderLinesDraft({ from: event.previousIndex, to: event.currentIndex, source: '舞台监督' }));
    }
  }

  reviewLine(lineId: string, decision: 'accepted' | 'returned') {
    this.store.dispatch(reviewLineDraft({ lineId, decision, source: '舞台监督' }));
  }

  reviewCue(cueId: string, decision: 'accepted' | 'returned') {
    this.store.dispatch(reviewCueDraft({ cueId, decision, source: '舞台监督' }));
  }

  editTiming(cueId: string, event: Event) {
    const timing = (event.target as HTMLInputElement).value;
    this.store.dispatch(editCueTimingDraft({ cueId, timing, source: '导演' }));
  }

  commit() {
    this.store.dispatch(commitBatch());
  }

  retry() {
    this.store.dispatch(retryBatch());
  }

  close() {
    this.store.dispatch(closeRehearsalWindow());
  }

  conflictGroups(): ConflictGroup[] {
    const map = new Map<string, ConflictItem[]>();
    for (const item of this.window.conflicts) {
      const list = map.get(item.source) ?? [];
      list.push(item);
      map.set(item.source, list);
    }
    return Array.from(map, ([source, items]) => ({ source, items }));
  }

  opKindLabel(op: PendingOp): string {
    switch (op.kind) {
      case 'reviewLine':
        return `台词${op.decision === 'accepted' ? '采纳' : '退回'} · ${op.lineId}`;
      case 'reorderLines':
        return `台词排序 ${op.from} → ${op.to}`;
      case 'reviewCue':
        return `提示${op.decision === 'accepted' ? '采纳' : '退回'} · ${op.cueId}`;
      case 'editCueTiming':
        return `提示计时 → ${op.timing || '未设置'} · ${op.cueId}`;
    }
  }

  opStatusLabel(status: PendingOp['status']): string {
    switch (status) {
      case 'pending':
        return '待同步';
      case 'conflict':
        return '冲突';
      case 'missing-number':
        return '缺号 · 已退回';
    }
  }

  writeStateLabel(state: RehearsalWindow['writeState']): string {
    switch (state) {
      case 'idle':
        return '尚未写出';
      case 'writing':
        return '写出中…';
      case 'failed':
        return '写出失败，队列已保留';
      case 'succeeded':
        return '整批写出成功，正式快照已替换';
    }
  }
}

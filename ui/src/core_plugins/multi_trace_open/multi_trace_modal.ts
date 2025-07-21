// Copyright (C) 2023 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {assertFalse} from '../../base/logging';
import {closeModal, redrawModal, showModal} from '../../widgets/modal';
import {Button, ButtonGroup, ButtonVariant} from '../../widgets/button';
import {CardStack} from '../../widgets/card';
import {Intent} from '../../widgets/common';
import {Icon} from '../../widgets/icon';
import {PopupPosition} from '../../widgets/popup';
import {Select} from '../../widgets/select';
import {Stack} from '../../widgets/stack';
import {Tooltip} from '../../widgets/tooltip';
import {TraceFileStream} from '../../core/trace_stream';
import {WasmEngineProxy} from '../../trace_processor/wasm_engine_proxy';
import {uuidv4} from '../../base/uuid';
import {AppImpl} from '../../core/app_impl';
import {MiddleEllipsis} from '../../widgets/middle_ellipsis';
import {NUM, STR} from '../../trace_processor/query_result';

const MODAL_KEY = 'multi-trace-modal';

function getErrorMessage(e: unknown): string {
  const err = e instanceof Error ? e.message : `${e}`;
  if (err.includes('(ERR:fmt)')) {
    return `The file opened doesn't look like a Perfetto trace or any other supported trace format.`;
  }
  return err;
}

function mapTraceType(rawType: string): string {
  switch (rawType) {
    case 'proto':
      return 'Perfetto';
    default:
      return rawType;
  }
}

function getTooltipText(traces: TraceFile[]): string {
  if (traces.length === 0) {
    return 'Add at least one trace to open.';
  }
  if (traces.some((t) => t.status === 'analyzing')) {
    return 'Wait for all traces to be analyzed.';
  }
  if (traces.some((t) => t.status === 'error')) {
    return 'Remove traces with errors before opening.';
  }
  return 'All traces must be analyzed before opening.';
}

function getStatusInfo(status: TraceStatus) {
  switch (status) {
    case 'analyzed':
      return {
        class: '.pf-multi-trace-modal__status--analyzed',
        text: 'Analyzed',
      };
    case 'analyzing':
      return {
        class: '.pf-multi-trace-modal__status--analyzing',
        text: 'Analyzing...',
      };
    case 'not-analyzed':
      return {
        class: '',
        text: 'Not analyzed',
      };
    case 'error':
      return {
        class: '.pf-multi-trace-modal__status--error',
        text: 'Error',
      };
    default:
      return {
        class: '',
        text: 'Unknown',
      };
  }
}

function areAllTracesAnalyzed(traces: TraceFile[]): boolean {
  return traces.every((trace) => trace.status === 'analyzed');
}

function isAnalyzing(traces: TraceFile[]): boolean {
  return traces.some((trace) => trace.status === 'analyzing');
}

type TraceStatus = 'not-analyzed' | 'analyzing' | 'analyzed' | 'error';

interface TraceFile {
  uuid: string;
  file: File;
  status: TraceStatus;
  error?: string;
  progress?: number;
  format?: string;
  clocks?: {name: string; count: number}[];
  syncMode: 'ROOT' | 'SYNC_TO_OTHER';
  rootClock?: string;
  syncClock?: {
    fromClock: string;
    toTraceUuid: string;
    toClock: string;
  };
}

interface MultiTraceModalAttrs {
  initialFiles: ReadonlyArray<File>;
}

class MultiTraceModalComponent
  implements m.ClassComponent<MultiTraceModalAttrs>
{
  private traces: TraceFile[] = [];
  private selectedTrace?: TraceFile;
  private hasRunRootClockDetection = false;

  // Lifecycle
  oncreate({attrs}: m.Vnode<MultiTraceModalAttrs>) {
    if (this.traces.length === 0) {
      this.analyzeFiles(attrs.initialFiles);
    }
  }

  view() {
    // This state should not be reachable. If we are analyzing, we should
    // have traces.
    assertFalse(isAnalyzing(this.traces) && this.traces.length === 0);
    return m(
      Stack,
      {className: 'pf-multi-trace-modal'},
      m(
        Stack,
        {orientation: 'horizontal'},
        m(
          Stack,
          {className: 'pf-multi-trace-modal__list-panel'},
          this.traces.map((trace, index) => this.renderTraceItem(trace, index)),
          m(
            CardStack,
            {
              className: 'pf-multi-trace-modal__add-card',
              onclick: () => this.addTraces(),
            },
            m(Icon, {icon: 'add'}),
            'Add more traces',
          ),
        ),
        m('.pf-multi-trace-modal__separator'),
        this.renderDetailsPanel(),
      ),
      m('.pf-multi-trace-modal__footer', this.renderActions()),
    );
  }

  // Main Renderers
  private renderDetailsPanel() {
    if (!this.selectedTrace) {
      return m(
        Stack,
        {className: 'pf-multi-trace-modal__details-panel'},
        m('h3', 'Add a trace file to get started'),
      );
    }

    const trace = this.selectedTrace;

    return m(
      Stack,
      {className: 'pf-multi-trace-modal__details-panel'},
      m('h3.pf-multi-trace-modal__details-header', trace.file.name),
      m(
        Stack,
        {
          className: 'pf-multi-trace-modal__details-content',
        },
        this.renderSyncModeSelector(trace),
        trace.syncMode === 'ROOT'
          ? this.renderRootClockSelector(trace)
          : this.renderSyncToOtherSelector(trace),
      ),
    );
  }

  private renderSyncModeSelector(trace: TraceFile) {
    return m(
      Stack,
      {className: 'pf-multi-trace-modal__form-group'},
      m('label', 'Sync Mode'),
      m(
        ButtonGroup,
        m(Button, {
          label: 'Root clock provider',
          active: trace.syncMode === 'ROOT',
          onclick: () => (trace.syncMode = 'ROOT'),
        }),
        m(Button, {
          label: 'Sync to another trace',
          active: trace.syncMode === 'SYNC_TO_OTHER',
          onclick: () => (trace.syncMode = 'SYNC_TO_OTHER'),
        }),
      ),
    );
  }

  private renderRootClockSelector(trace: TraceFile) {
    return m(
      Stack,
      {className: 'pf-multi-trace-modal__form-group'},
      m('label', 'Root Clock'),
      m(
        Select,
        {
          value: trace.rootClock ?? '',
          onchange: (e: Event) => {
            const target = e.target as HTMLSelectElement;
            trace.rootClock = target.value;
          },
        },
        m('option', {value: ''}, 'Select a clock'),
        (trace.clocks ?? []).map((clock) =>
          m('option', {value: clock.name}, clock.name),
        ),
      ),
    );
  }

  private renderSyncToOtherSelector(trace: TraceFile) {
    const otherTraces = this.traces.filter((t) => t.uuid !== trace.uuid);
    return [
      m(
        Stack,
        {className: 'pf-multi-trace-modal__form-group'},
        m('label', 'Source Clock'),
        m(
          Select,
          {
            value: trace.syncClock?.fromClock ?? '',
            onchange: (e: Event) => {
              const target = e.target as HTMLSelectElement;
              trace.syncClock = {
                ...(trace.syncClock ?? {
                  toTraceUuid: '',
                  toClock: '',
                }),
                fromClock: target.value,
              };
            },
          },
          m('option', {value: ''}, 'Select a clock'),
          (trace.clocks ?? []).map((clock) =>
            m('option', {value: clock.name}, clock.name),
          ),
        ),
      ),
      m(
        Stack,
        {className: 'pf-multi-trace-modal__form-group'},
        m('label', 'Target Trace'),
        m(
          Select,
          {
            value: trace.syncClock?.toTraceUuid ?? '',
            onchange: (e: Event) => {
              const target = e.target as HTMLSelectElement;
              trace.syncClock = {
                ...(trace.syncClock ?? {fromClock: ''}),
                toTraceUuid: target.value,
                toClock: '', // Reset target clock when target trace changes
              };
              redrawModal();
            },
          },
          m('option', {value: ''}, 'Select a trace'),
          otherTraces.map((other) =>
            m('option', {value: other.uuid}, other.file.name),
          ),
        ),
      ),
      trace.syncClock?.toTraceUuid &&
        m(
          Stack,
          {className: 'pf-multi-trace-modal__form-group'},
          m('label', 'Target Clock'),
          m(
            Select,
            {
              value: trace.syncClock?.toClock ?? '',
              onchange: (e: Event) => {
                const target = e.target as HTMLSelectElement;
                trace.syncClock = {
                  ...(trace.syncClock ?? {
                    fromClock: '',
                    toTraceUuid: '',
                  }),
                  toClock: target.value,
                };
              },
            },
            m('option', {value: ''}, 'Select a clock'),
            (
              this.traces.find((t) => t.uuid === trace.syncClock?.toTraceUuid)
                ?.clocks ?? []
            ).map((clock) => m('option', {value: clock.name}, clock.name)),
          ),
        ),
    ];
  }

  private renderActions() {
    const isDisabled =
      !areAllTracesAnalyzed(this.traces) || this.traces.length === 0;
    if (!isDisabled) {
      return this.renderOpenTracesButton(false);
    }
    return m(
      Tooltip,
      {
        className: 'pf-multi-trace-modal__open-traces-tooltip',
        trigger: this.renderOpenTracesButton(true),
      },
      getTooltipText(this.traces),
    );
  }

  // Sub-Renderers
  private renderTraceItem(trace: TraceFile, index: number) {
    return m(
      CardStack,
      {
        className: 'pf-multi-trace-modal__card',
        direction: 'horizontal',
        key: trace.file.name,
      },
      this.renderTraceInfo(trace),
      this.renderCardActions(trace, index),
    );
  }

  private renderOpenTracesButton(isDisabled: boolean) {
    return m(Button, {
      label: 'Open Traces',
      intent: Intent.Primary,
      variant: ButtonVariant.Filled,
      onclick: () => this.openTraces(),
      disabled: isDisabled,
    });
  }

  private renderTraceInfo(trace: TraceFile) {
    return m(
      Stack,
      {
        className: 'pf-multi-trace-modal__info',
      },
      m(MiddleEllipsis, {
        text: trace.file.name,
        className: 'pf-multi-trace-modal__name',
      }),
      m(
        Stack,
        {
          orientation: 'horizontal',
        },
        m(
          Stack,
          {
            className: 'pf-multi-trace-modal__size',
            orientation: 'horizontal',
          },
          m('strong', 'Size:'),
          m('span', `${(trace.file.size / (1024 * 1024)).toFixed(1)} MB`),
        ),
        trace.status === 'analyzed' && trace.format
          ? m(
              Stack,
              {
                className: 'pf-multi-trace-modal__format',
                orientation: 'horizontal',
              },
              m('strong', 'Format:'),
              m('span', trace.format),
            )
          : this.renderTraceStatus(trace),
      ),
    );
  }

  private renderCardActions(trace: TraceFile, index: number) {
    return m(
      '.pf-multi-trace-modal__actions',
      m(Button, {
        icon: 'edit',
        onclick: () => (this.selectedTrace = trace),
      }),
      m(Button, {
        icon: 'delete',
        onclick: () => this.removeTrace(index),
        disabled: isAnalyzing(this.traces),
      }),
    );
  }

  private renderTraceStatus(trace: TraceFile) {
    const statusInfo = getStatusInfo(trace.status);
    const progressText =
      trace.status === 'analyzing' && trace.progress !== undefined
        ? `(${(trace.progress * 100).toFixed(0)}%)`
        : '';
    return m(
      '.pf-multi-trace-modal__status-wrapper',
      m(
        '.pf-multi-trace-modal__status' + statusInfo.class,
        `${statusInfo.text} ${progressText}`,
      ),
      trace.status === 'error' &&
        trace.error &&
        m(
          Tooltip,
          {
            className: 'pf-multi-trace-modal__status-tooltip',
            position: PopupPosition.Bottom,
            trigger: m(Icon, {
              icon: 'help_outline',
              className: 'pf-hint',
            }),
          },
          trace.error,
        ),
    );
  }

  // Public Actions
  private openTraces() {
    if (this.traces.length === 0) {
      return;
    }
    const files = this.traces.map((t) => t.file);
    AppImpl.instance.openTraceFromMultipleFiles(files);
    closeModal(MODAL_KEY);
  }

  private addTraces() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      if (!input.files) {
        return;
      }
      this.analyzeFiles([...input.files]);
    });
    input.click();
  }

  private removeTrace(index: number) {
    const removedTrace = this.traces[index];
    this.traces.splice(index, 1);
    if (this.selectedTrace === removedTrace) {
      this.selectedTrace = this.traces.length > 0 ? this.traces[0] : undefined;
    }
    redrawModal();
  }

  // Core Logic
  private async analyzeFiles(files: ReadonlyArray<File>) {
    if (isAnalyzing(this.traces) || files.length === 0) {
      return;
    }
    const newTraces: TraceFile[] = [];
    for (const file of files) {
      const isDuplicate = this.traces.some((t) => t.file.name === file.name);
      const trace: TraceFile = {
        uuid: uuidv4(),
        file,
        status: isDuplicate ? 'error' : 'not-analyzed',
        error: isDuplicate ? 'This file has already been added.' : undefined,
        progress: 0,
        syncMode: 'SYNC_TO_OTHER',
      };
      this.traces.push(trace);
      if (!isDuplicate) {
        newTraces.push(trace);
      }
    }
    if (!this.selectedTrace && this.traces.length > 0) {
      this.selectedTrace = this.traces[0];
    }
    redrawModal();

    await Promise.all(newTraces.map((trace) => this.analyzeTrace(trace)));

    if (!this.hasRunRootClockDetection) {
      this.determineRootClockAndSyncPaths();
      this.hasRunRootClockDetection = true;
    }
    redrawModal();
  }

  private determineRootClockAndSyncPaths() {
    // 1. Aggregate all clocks from all traces
    const allClocks = new Map<string, number>();
    for (const trace of this.traces) {
      if (trace.clocks) {
        for (const clock of trace.clocks) {
          const currentCount = allClocks.get(clock.name) ?? 0;
          allClocks.set(clock.name, currentCount + clock.count);
        }
      }
    }

    if (allClocks.size === 0) {
      return; // No clocks found
    }

    // 2. Find the clock with the most snapshots across all traces
    let rootClock = '';
    let maxCount = 0;
    for (const [name, count] of allClocks.entries()) {
      if (count > maxCount) {
        maxCount = count;
        rootClock = name;
      }
    }

    // 3. Find the trace with the most snapshots of the root clock
    let primaryTrace: TraceFile | undefined = undefined;
    let maxSnapshotsInTrace = 0;

    for (const trace of this.traces) {
      const rootClockInTrace = trace.clocks?.find((c) => c.name === rootClock);
      if (rootClockInTrace && rootClockInTrace.count > maxSnapshotsInTrace) {
        maxSnapshotsInTrace = rootClockInTrace.count;
        primaryTrace = trace;
      }
    }

    // 4. Set sync modes
    if (primaryTrace) {
      for (const trace of this.traces) {
        if (trace === primaryTrace) {
          trace.syncMode = 'ROOT';
          trace.rootClock = rootClock;
        } else {
          trace.syncMode = 'SYNC_TO_OTHER';
          if (trace.clocks?.some((c) => c.name === rootClock)) {
            trace.syncClock = {
              fromClock: rootClock,
              toTraceUuid: primaryTrace.uuid,
              toClock: rootClock,
            };
          }
        }
      }
    }
  }

  private async analyzeTrace(trace: TraceFile) {
    if (trace.status !== 'not-analyzed') {
      return;
    }
    trace.status = 'analyzing';
    redrawModal();
    try {
      using engine = new WasmEngineProxy(uuidv4());
      const stream = new TraceFileStream(trace.file);
      engine.resetTraceProcessor({
        tokenizeOnly: true,
        cropTrackEvents: false,
        ingestFtraceInRawTable: false,
        analyzeTraceProtoContent: false,
        ftraceDropUntilAllCpusValid: false,
      });
      for (;;) {
        const res = await stream.readChunk();
        trace.progress = res.bytesRead / trace.file.size;
        redrawModal();
        await engine.parse(res.data);
        if (res.eof) {
          await engine.notifyEof();
          break;
        }
      }
      const result = await engine.query(`
        SELECT
          parent.trace_type
        FROM __intrinsic_trace_file parent
        LEFT JOIN __intrinsic_trace_file child ON parent.id = child.parent_id
        WHERE child.id IS NULL
      `);
      const it = result.iter({trace_type: STR});
      const leafNodes = [];
      for (; it.valid(); it.next()) {
        leafNodes.push(it.trace_type);
      }
      if (leafNodes.length > 1) {
        trace.status = 'error';
        trace.error =
          'This trace contains multiple sub-traces, which is not supported because recursive synchronization is tricky. Please open each sub-trace individually.';
      } else if (leafNodes.length === 1) {
        trace.format = mapTraceType(leafNodes[0]);
        trace.status = 'analyzed';
      } else {
        // This case should ideally not be reached with a valid trace
        trace.status = 'error';
        trace.error = 'Could not determine trace type';
      }

      // Also query for the clocks in this trace
      const clocksResult = await engine.query(`
        SELECT clock_name, COUNT(*) as count
        FROM clock_snapshot
        WHERE clock_name IS NOT NULL
        GROUP BY clock_name
        ORDER BY count DESC
      `);
      const clocks: {name: string; count: number}[] = [];
      const clockIt = clocksResult.iter({clock_name: STR, count: NUM});
      for (; clockIt.valid(); clockIt.next()) {
        clocks.push({name: clockIt.clock_name, count: clockIt.count});
      }
      trace.clocks = clocks;

      trace.progress = 1;
    } catch (e) {
      trace.status = 'error';
      trace.error = getErrorMessage(e);
    } finally {
      redrawModal();
    }
  }
}

export function showMultiTraceModal(initialFiles: File[]) {
  showModal({
    title: 'Open Multiple Traces',
    icon: 'library_books',
    key: MODAL_KEY,
    className: 'pf-multi-trace-modal-override',
    content: () => m(MultiTraceModalComponent, {initialFiles}),
  });
}

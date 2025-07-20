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
import {Button, ButtonVariant} from '../../widgets/button';
import {Card} from '../../widgets/card';
import {Intent} from '../../widgets/common';
import {Icon} from '../../widgets/icon';
import {PopupPosition} from '../../widgets/popup';
import {Tooltip} from '../../widgets/tooltip';
import {TraceFileStream} from '../../core/trace_stream';
import {WasmEngineProxy} from '../../trace_processor/wasm_engine_proxy';
import {uuidv4} from '../../base/uuid';
import {AppImpl} from '../../core/app_impl';
import {MiddleEllipsis} from '../../widgets/middle_ellipsis';
import {STR} from '../../trace_processor/query_result';

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


type TraceStatus = 'not-analyzed' | 'analyzing' | 'analyzed' | 'error';

interface TraceFile {
  file: File;
  status: TraceStatus;
  error?: string;
  progress?: number;
  format?: string;
}

interface MultiTraceModalAttrs {
  initialFiles: ReadonlyArray<File>;
}

class MultiTraceModalComponent
  implements m.ClassComponent<MultiTraceModalAttrs>
{
  private traces: TraceFile[] = [];

  // Lifecycle
  oncreate({attrs}: m.Vnode<MultiTraceModalAttrs>) {
    if (this.traces.length === 0) {
      this.analyzeFiles(attrs.initialFiles);
    }
  }

  view() {
    // This state should not be reachable. If we are analyzing, we should
    // have traces.
    assertFalse(this.isAnalyzing() && this.traces.length === 0);

    return m(
      '.pf-multi-trace-modal',
      this.traces.length === 0 ? this.renderEmpty() : this.renderTraceList(),
      m('footer', this.renderActions()),
    );
  }

  // Main Renderers
  private renderEmpty() {
    return this.renderAddTracesButton();
  }

  private renderTraceList() {
    return m(
      '.pf-multi-trace-modal__list',
      this.traces.map((trace, index) => this.renderTraceItem(trace, index)),
      this.renderAddTracesButton(),
    );
  }

  private renderActions() {
    const isDisabled =
      !this.areAllTracesAnalyzed() || this.traces.length === 0;

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
      Card,
      {
        key: trace.file.name,
      },
      m(
        '.pf-multi-trace-modal__card-content',
        this.renderTraceInfo(trace),
        this.renderCardActions(index),
      ),
    );
  }

  private renderAddTracesButton() {
    return m(
      Card,
      {
        className: 'pf-multi-trace-modal__add-card',
        onclick: () => this.addTraces(),
      },
      m(
        '.pf-multi-trace-modal__add-card-content',
        m(Icon, {icon: 'add'}),
        'Add more traces',
      ),
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
      '.pf-multi-trace-modal__info',
      m(
        '.pf-multi-trace-modal__name',
        m(MiddleEllipsis, {text: trace.file.name}),
      ),
      m(
        '.pf-multi-trace-modal__size',
        m('strong', 'Size:'),
        m(
          'span',
          `${(trace.file.size / (1024 * 1024)).toFixed(1)} MB`,
        ),
      ),
      trace.status === 'analyzed' && trace.format ?
        m(
            '.pf-multi-trace-modal__format',
            m('strong', 'Format:'),
            m('span', trace.format),
            ) :
        this.renderTraceStatus(trace),
    );
  }

  private renderCardActions(index: number) {
    return m(
      '.pf-multi-trace-modal__actions',
      m(Button, {
        icon: 'delete',
        onclick: () => this.removeTrace(index),
        disabled: this.isAnalyzing(),
      }),
    );
  }

  private renderTraceStatus(trace: TraceFile) {
    const statusInfo = getStatusInfo(trace.status);
    const progressText =
      trace.status === 'analyzing' && trace.progress !== undefined
        ? `(${(trace.progress * 100).toFixed(0)}%)`
        : '';

    const statusText = statusInfo.text;

    return m(
      '.pf-multi-trace-modal__status-wrapper',
      m(
        '.pf-multi-trace-modal__status' + statusInfo.class,
        `${statusText} ${progressText}`,
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
    this.traces.splice(index, 1);
    redrawModal();
  }

  // Core Logic
  private async analyzeFiles(files: ReadonlyArray<File>) {
    if (this.isAnalyzing() || files.length === 0) {
      return;
    }

    const newTraces: TraceFile[] = [];
    for (const file of files) {
      const isDuplicate = this.traces.some((t) => t.file.name === file.name);
      const trace: TraceFile = {
        file,
        status: isDuplicate ? 'error' : 'not-analyzed',
        error: isDuplicate ? 'This file has already been added.' : undefined,
        progress: 0,
      };
      this.traces.push(trace);
      if (!isDuplicate) {
        newTraces.push(trace);
      }
    }
    redrawModal();

    for (const trace of newTraces) {
      await this.analyzeTrace(trace);
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
      trace.progress = 1;
    } catch (e) {
      trace.status = 'error';
      trace.error = getErrorMessage(e);
    } finally {
      redrawModal();
    }
  }

  // Helpers
  private areAllTracesAnalyzed(): boolean {
    return this.traces.every((trace) => trace.status === 'analyzed');
  }

  private isAnalyzing(): boolean {
    return this.traces.some((trace) => trace.status === 'analyzing');
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

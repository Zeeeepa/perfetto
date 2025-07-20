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
import {NUM, STR, STR_NULL} from '../../trace_processor/query_result';

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

function getClockName(clock: Clock): string {
  return clock.clock_name ?? `Clock Id: ${clock.clock_id}`;
}

type TraceStatus = 'not-analyzed' | 'analyzing' | 'analyzed' | 'error';

interface Clock {
  clock_name: string | null;
  clock_id: number;
}

interface ClockLink {
  source: {trace: TraceFile; clock: Clock};
  target: {trace: TraceFile; clock: Clock};
}

interface TraceFile {
  file: File;
  status: TraceStatus;
  error?: string;
  progress?: number;
  format?: string;
  clocks?: Clock[];
}

interface MultiTraceModalAttrs {
  initialFiles: ReadonlyArray<File>;
}

class MultiTraceModalComponent
  implements m.ClassComponent<MultiTraceModalAttrs>
{
  private traces: TraceFile[] = [];
  private primaryClocks = new Map<TraceFile, Clock>();
  private manualLinks: ClockLink[] = [];
  private linkingFrom?: {trace: TraceFile; clock: Clock};
  private rootClock?: {trace: TraceFile; clock: Clock};

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
      m(
        '.pf-multi-trace-modal__subtitle',
        m('strong', 'Step 1: '),
        'Configure properties for each trace. The primary clock for each trace is chosen from the trace metadata if available, or by a heuristic.',
      ),
      this.traces.length === 0 ? this.renderEmpty() : this.renderTraceList(),
      m(
        '.pf-multi-trace-modal__subtitle',
        m('strong', 'Step 2:'),
        ' Link the primary clocks together. All clocks must have a path to a single root clock.',
      ),
      this.renderGraphCanvas(),
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
      !this.areAllTracesAnalyzed() ||
      this.traces.length === 0 ||
      !this.isGraphFullyConnected();

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

  private renderGraphCanvas() {
    const traces = this.traces;
    if (traces.length < 2) {
      return m(
        '.pf-multi-trace-modal__graph-canvas-placeholder',
        'Add at least two traces to configure clock synchronization.',
      );
    }

    const canvasWidth = 768; // width of modal - padding
    const canvasHeight = 200;
    const centerX = canvasWidth / 2;
    const centerY = canvasHeight / 2;
    const radius = Math.min(centerX, centerY) * 0.8;

    const nodePositions = new Map<TraceFile, {x: number; y: number}>();
    const angleStep = (2 * Math.PI) / traces.length;

    traces.forEach((trace, i) => {
      const angle = i * angleStep - Math.PI / 2; // Start from top
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      nodePositions.set(trace, {x, y});
    });

    const autoLinks = this.getAutoLinks();
    const manualLinks = this.manualLinks;

    const renderLink = (link: ClockLink, dashed: boolean) => {
      const sourcePos = nodePositions.get(link.source.trace);
      const targetPos = nodePositions.get(link.target.trace);

      if (!sourcePos || !targetPos) return null;

      return m('line', {
        x1: sourcePos.x,
        y1: sourcePos.y,
        x2: targetPos.x,
        y2: targetPos.y,
        class: dashed ? 'graph-link-dashed' : 'graph-link-solid',
      });
    };

    return m(
      '.pf-multi-trace-modal__graph-canvas',
      m(
        'svg.graph-svg',
        {width: canvasWidth, height: canvasHeight},
        autoLinks.map((link) => renderLink(link, true)),
        manualLinks.map((link) => renderLink(link, false)),
      ),
      traces.map((trace) => {
        const pos = nodePositions.get(trace);
        if (!pos) return null;
        const primaryClock = this.primaryClocks.get(trace);

        // Determine if this trace is the root
        const isRoot = this.rootClock?.trace === trace;

        return m(
          '.graph-node',
          {
            style: `left: ${pos.x}px; top: ${pos.y}px;`,
            class: isRoot ? 'graph-node-root' : '',
          },
          m(MiddleEllipsis, {text: trace.file.name}),
          primaryClock && m('.graph-node-clock', getClockName(primaryClock)),
        );
      }),
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
    const trace = this.traces[index];
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
    const removedTrace = this.traces[index];
    this.traces.splice(index, 1);

    // Clean up state associated with the removed trace
    this.primaryClocks.delete(removedTrace);
    this.manualLinks = this.manualLinks.filter(
      (link) =>
        link.source.trace !== removedTrace && link.target.trace !== removedTrace,
    );
    if (this.rootClock?.trace === removedTrace) {
      this.rootClock = undefined;
    }
    if (this.linkingFrom?.trace === removedTrace) {
      this.linkingFrom = undefined;
    }

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

        const clocksResult = await engine.query(`
          SELECT DISTINCT
            clock_name,
            clock_id
          FROM clock_snapshot
        `);
        const clocks: Clock[] = [];
        const clockIt = clocksResult.iter({
          clock_name: STR_NULL,
          clock_id: NUM,
        });
        for (; clockIt.valid(); clockIt.next()) {
          clocks.push({
            clock_name: clockIt.clock_name,
            clock_id: clockIt.clock_id,
          });
        }
        trace.clocks = clocks;

        const defaultClockIdResult = await engine.query(`
          SELECT int_value FROM metadata WHERE name = 'trace_time_clock_id'
        `);
        const defaultClockIdIt =
          defaultClockIdResult.iter({int_value: NUM});

        let defaultClock: Clock|undefined = undefined;
        if (defaultClockIdIt.valid()) {
          const defaultClockId = defaultClockIdIt.int_value;
          defaultClock =
            trace.clocks.find((c) => c.clock_id === defaultClockId);
        }

        // Fallback to the first clock if no default is found
        if (!defaultClock && trace.clocks.length > 0) {
          defaultClock = trace.clocks[0];
        }

        if (defaultClock) {
          this.primaryClocks.set(trace, defaultClock);
        }
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

  private isGraphFullyConnected(): boolean {
    if (!this.rootClock) {
      // If no clocks are selected, the graph is trivially connected.
      return this.primaryClocks.size === 0;
    }

    const allLinks = this.manualLinks.concat(this.getAutoLinks());
    const adjacencyList = new Map<string, string[]>();

    const allNodes = new Set<string>();
    for (const [trace, clock] of this.primaryClocks.entries()) {
      const nodeKey = JSON.stringify({trace: trace.file.name, clock});
      allNodes.add(nodeKey);
      adjacencyList.set(nodeKey, []);
    }

    for (const link of allLinks) {
      const sourceKey = JSON.stringify({
        trace: link.source.trace.file.name,
        clock: link.source.clock,
      });
      const targetKey = JSON.stringify({
        trace: link.target.trace.file.name,
        clock: link.target.clock,
      });
      adjacencyList.get(sourceKey)?.push(targetKey);
      adjacencyList.get(targetKey)?.push(sourceKey);
    }

    const visited = new Set<string>();
    const queue: {trace: TraceFile; clock: Clock}[] = [this.rootClock];
    visited.add(
      JSON.stringify({
        trace: this.rootClock.trace.file.name,
        clock: this.rootClock.clock,
      }),
    );

    while (queue.length > 0) {
      const node = queue.shift()!;
      const nodeKey = JSON.stringify({
        trace: node.trace.file.name,
        clock: node.clock,
      });
      const neighbors = adjacencyList.get(nodeKey) || [];
      for (const neighborKey of neighbors) {
        if (!visited.has(neighborKey)) {
          visited.add(neighborKey);
          // This is inefficient, but ok for now.
          for (const n of allNodes) {
            if (n === neighborKey) {
              const parsed = JSON.parse(n);
              const trace = this.traces.find(
                (t) => t.file.name === parsed.trace,
              )!;
              queue.push({trace, clock: parsed.clock});
            }
          }
        }
      }
    }
    return visited.size === allNodes.size;
  }

  private getAutoLinks(): ClockLink[] {
    const nodes: {trace: TraceFile; clock: Clock}[] = [];
    for (const [trace, clock] of this.primaryClocks.entries()) {
      nodes.push({trace, clock});
    }

    const links: ClockLink[] = [];
    const clocksByName = new Map<string, {trace: TraceFile; clock: Clock}[]>();

    for (const node of nodes) {
      if (node.clock.clock_name) {
        if (!clocksByName.has(node.clock.clock_name)) {
          clocksByName.set(node.clock.clock_name, []);
        }
        clocksByName.get(node.clock.clock_name)!.push(node);
      }
    }

    for (const group of clocksByName.values()) {
      for (let i = 0; i < group.length - 1; i++) {
        links.push({source: group[i], target: group[i + 1]});
      }
    }
    return links;
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

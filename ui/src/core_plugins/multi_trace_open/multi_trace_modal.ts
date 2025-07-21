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
import {closeModal, redrawModal, showModal} from '../../widgets/modal';
import {Button, ButtonGroup, ButtonVariant} from '../../widgets/button';
import {CardStack} from '../../widgets/card';
import {Intent} from '../../widgets/common';
import {Icon} from '../../widgets/icon';
import {PopupPosition} from '../../widgets/popup';
import {Select} from '../../widgets/select';
import {Stack} from '../../widgets/stack';
import {Tooltip} from '../../widgets/tooltip';
import {AppImpl} from '../../core/app_impl';
import {MiddleEllipsis} from '../../widgets/middle_ellipsis';
import {TraceFile, TraceFileAnalyzed, TraceStatus} from './multi_trace_types';
import {MultiTraceController} from './multi_trace_controller';

const MODAL_KEY = 'multi-trace-modal';

interface MultiTraceModalAttrs {
  initialFiles: ReadonlyArray<File>;
}

class MultiTraceModalComponent
  implements m.ClassComponent<MultiTraceModalAttrs>
{
  private controller = new MultiTraceController();

  // Lifecycle
  oncreate({attrs}: m.Vnode<MultiTraceModalAttrs>) {
    this.controller.addFiles(attrs.initialFiles);
  }

  view() {
    return m(
      Stack,
      {className: 'pf-multi-trace-modal'},
      m(
        Stack,
        {
          className: 'pf-multi-trace-modal__main',
          orientation: 'horizontal',
        },
        m(
          Stack,
          {className: 'pf-multi-trace-modal__list-panel'},
          this.controller.traces.map((trace, index) =>
            this.renderTraceItem(trace, index),
          ),
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
      m(
        Stack,
        {className: 'pf-multi-trace-modal__footer', orientation: 'horizontal'},
        this.renderActions(),
      ),
    );
  }

  // Main Renderers
  private renderDetailsPanel() {
    if (!this.controller.selectedTrace) {
      return undefined;
    }
    const trace = this.controller.selectedTrace;
    return m(
      Stack,
      {className: 'pf-multi-trace-modal__details-panel'},
      m('h3.pf-multi-trace-modal__details-header', trace.file.name),
      trace.status === 'analyzed'
        ? m(
            Stack,
            {
              className: 'pf-multi-trace-modal__details-content',
            },
            this.renderSyncModeSelector(trace),
            trace.syncMode === 'MANUAL'
              ? trace.syncConfig.syncMode === 'ROOT'
                ? this.renderRootClockSelector(trace)
                : this.renderSyncToOtherSelector(trace)
              : this.renderAutomaticSyncDetails(trace),
          )
        : m('span', 'TODO add viz depending on status'),
    );
  }

  private renderSyncModeSelector(trace: TraceFileAnalyzed) {
    return m(
      Stack,
      {className: 'pf-multi-trace-modal__form-group'},
      m('label', 'Sync Mode'),
      m(
        ButtonGroup,
        m(Button, {
          label: 'Automatic',
          active: trace.syncMode === 'AUTOMATIC',
          onclick: () => {
            trace.syncMode = 'AUTOMATIC';
          },
        }),
        m(Button, {
          label: 'Manual',
          active: trace.syncMode === 'MANUAL',
          onclick: () => {
            trace.syncMode = 'MANUAL';
          },
        }),
      ),
    );
  }

  private renderRootClockSelector(trace: TraceFileAnalyzed) {
    if (trace.syncConfig.syncMode !== 'ROOT') {
      return;
    }
    return m(
      Stack,
      {className: 'pf-multi-trace-modal__form-group'},
      m('label', 'Root Clock'),
      m(
        Select,
        {
          value: trace.syncConfig.rootClock,
          onchange: (e: Event) => {
            const target = e.target as HTMLSelectElement;
            trace.syncConfig = {
              syncMode: 'ROOT',
              rootClock: target.value,
            };
          },
        },
        m('option', {value: ''}, 'Select a clock'),
        trace.clocks.map((clock) =>
          m('option', {value: clock.name}, clock.name),
        ),
      ),
    );
  }

  private renderAutomaticSyncDetails(trace: TraceFileAnalyzed) {
    const config = trace.syncConfig;
    if (config.syncMode === 'ROOT') {
      return m(
        Stack,
        {className: 'pf-multi-trace-modal__form-group'},
        m('label', 'Role'),
        m('span', 'Root clock provider'),
        m('label', 'Root Clock'),
        m('span', config.rootClock),
      );
    } else {
      return m(
        Stack,
        {className: 'pf-multi-trace-modal__form-group'},
        m('label', 'Role'),
        m('span', 'Synced to another trace'),
        m('label', 'Source Clock'),
        m('span', config.syncClock?.fromClock ?? 'Not set'),
        m('label', 'Target Trace'),
        m('span', trace.file.name ?? 'Not set'),
        m('label', 'Target Clock'),
        m('span', config.syncClock?.toClock ?? 'Not set'),
      );
    }
  }

  private renderSyncToOtherSelector(trace: TraceFileAnalyzed) {
    const syncConfig = trace.syncConfig;
    if (syncConfig.syncMode !== 'SYNC_TO_OTHER') {
      return;
    }
    const otherTraces = this.controller.traces.filter(
      (t) => t.uuid !== trace.uuid,
    );
    return [
      m(
        Stack,
        {className: 'pf-multi-trace-modal__form-group'},
        m('label', 'Source Clock'),
        m(
          Select,
          {
            value: syncConfig.syncClock?.fromClock ?? '',
            onchange: (e: Event) => {
              const target = e.target as HTMLSelectElement;
              trace.syncConfig = {
                syncMode: 'SYNC_TO_OTHER',
                syncClock: {
                  ...(syncConfig.syncClock ?? {
                    toTraceUuid: '',
                    toClock: '',
                  }),
                  fromClock: target.value,
                },
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
            value: syncConfig.syncClock?.toTraceUuid ?? '',
            onchange: (e: Event) => {
              const target = e.target as HTMLSelectElement;
              trace.syncConfig = {
                syncMode: 'SYNC_TO_OTHER',
                syncClock: {
                  ...(syncConfig.syncClock ?? {fromClock: ''}),
                  toTraceUuid: target.value,
                  toClock: '', // Reset target clock when target trace changes
                },
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
      syncConfig.syncClock?.toTraceUuid &&
        m(
          Stack,
          {className: 'pf-multi-trace-modal__form-group'},
          m('label', 'Target Clock'),
          m(
            Select,
            {
              value: syncConfig.syncClock?.toClock ?? '',
              onchange: (e: Event) => {
                const target = e.target as HTMLSelectElement;
                trace.syncConfig = {
                  syncMode: 'SYNC_TO_OTHER',
                  syncClock: {
                    ...(syncConfig.syncClock ?? {
                      fromClock: '',
                      toTraceUuid: '',
                    }),
                    toClock: target.value,
                  },
                };
              },
            },
            m('option', {value: ''}, 'Select a clock'),
            (
              this.controller.traces.find(
                (t) => t.uuid === syncConfig.syncClock?.toTraceUuid,
              ) as TraceFileAnalyzed | undefined
            )?.clocks.map((clock) =>
              m('option', {value: clock.name}, clock.name),
            ),
          ),
        ),
    ];
  }

  private renderActions() {
    const isDisabled =
      !areAllTracesAnalyzed(this.controller.traces) ||
      this.controller.traces.length === 0;
    if (!isDisabled) {
      return this.renderOpenTracesButton(false);
    }
    return m(
      Tooltip,
      {
        className: 'pf-multi-trace-modal__open-traces-tooltip',
        trigger: this.renderOpenTracesButton(true),
      },
      getTooltipText(this.controller.traces),
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
        spacing: 'large',
      },
      m(MiddleEllipsis, {
        text: trace.file.name,
        className: 'pf-multi-trace-modal__name',
      }),
      m(
        Stack,
        {orientation: 'horizontal', spacing: 'large'},
        m(
          Stack,
          {
            className: 'pf-multi-trace-modal__size',
            orientation: 'horizontal',
          },
          m('strong', 'Size:'),
          m('span', `${(trace.file.size / (1024 * 1024)).toFixed(1)} MB`),
        ),
        trace.status === 'analyzed'
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
        onclick: () => (this.controller.selectedTrace = trace),
      }),
      m(Button, {
        icon: 'delete',
        onclick: () => this.controller.removeTrace(index),
        disabled: isAnalyzing(this.controller.traces),
      }),
    );
  }

  private renderTraceStatus(trace: TraceFile) {
    const statusInfo = getStatusInfo(trace.status);
    const progressText =
      trace.status === 'analyzing'
        ? ` (${(trace.progress * 100).toFixed(0)}%)`
        : '';
    return m(
      Stack,
      {
        orientation: 'horizontal',
        className: 'pf-multi-trace-modal__status-wrapper',
      },
      m(
        '.pf-multi-trace-modal__status' + statusInfo.class,
        `${statusInfo.text}${progressText}`,
      ),
      trace.status === 'error' &&
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
  private addTraces() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      if (input.files) {
        this.controller.addFiles([...input.files]);
      }
    });
    input.click();
  }

  private openTraces() {
    if (this.controller.traces.length === 0) {
      return;
    }
    const files = this.controller.traces.map((t) => t.file);
    AppImpl.instance.openTraceFromMultipleFiles(files);
    closeModal(MODAL_KEY);
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

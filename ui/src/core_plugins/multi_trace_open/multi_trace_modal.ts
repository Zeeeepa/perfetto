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
import {Button, ButtonVariant} from '../../widgets/button';
import {CardStack} from '../../widgets/card';
import {Intent} from '../../widgets/common';
import {Icon} from '../../widgets/icon';
import {PopupPosition} from '../../widgets/popup';
import {Select} from '../../widgets/select';
import {Spinner} from '../../widgets/spinner';
import {Stack} from '../../widgets/stack';
import {Switch} from '../../widgets/switch';
import {Tooltip} from '../../widgets/tooltip';
import {AppImpl} from '../../core/app_impl';
import {MiddleEllipsis} from '../../widgets/middle_ellipsis';
import {
  SyncConfig,
  TraceFile,
  TraceFileAnalyzed,
  TraceStatus,
} from './multi_trace_types';
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
          this.controller.traces.map((trace) => this.renderTraceItem(trace)),
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
        this.controller.selectedTrace && [
          m('.pf-multi-trace-modal__separator'),
          this.renderDetailsPanel(),
        ],
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
    const trace = this.controller.selectedTrace;
    if (!trace) {
      return undefined;
    }
    return m(
      Stack,
      {className: 'pf-multi-trace-modal__details-panel'},
      m('h3.pf-multi-trace-modal__details-header', trace.file.name),
      trace.status === 'analyzed'
        ? this.renderAnalyzedDetails(trace)
        : m('span', 'TODO add viz depending on status'),
    );
  }

  private renderAnalyzedDetails(trace: TraceFileAnalyzed) {
    const isManual = trace.syncMode === 'MANUAL';
    const config = trace.syncConfig;

    return m(
      Stack,
      {
        className: 'pf-multi-trace-modal__details-content',
      },
      this.renderSyncModeSelector(trace),
      this.renderDetailRow(
        'Role',
        isManual
          ? this.renderRoleSelector(trace)
          : m(
              'span.pf-multi-trace-modal__static-select',
              config.syncMode === 'ROOT'
                ? 'Root clock provider'
                : 'Synced to another trace',
            ),
      ),
      config.syncMode === 'ROOT'
        ? this.renderRootTraceDetails(trace, isManual)
        : this.renderSyncedTraceDetails(trace, isManual),
    );
  }

  private renderRootTraceDetails(trace: TraceFileAnalyzed, isManual: boolean) {
    if (trace.syncConfig.syncMode !== 'ROOT') return [];
    const config = trace.syncConfig;
    return [
      this.renderDetailRow(
        'Root Clock',
        isManual
          ? this.renderRootClockSelector(trace)
          : m('span.pf-multi-trace-modal__static-select', config.rootClock),
      ),
    ];
  }

  private renderSyncedTraceDetails(
    trace: TraceFileAnalyzed,
    isManual: boolean,
  ) {
    if (trace.syncConfig.syncMode !== 'SYNC_TO_OTHER') return [];
    const config = trace.syncConfig;
    const otherTraces = this.controller.traces.filter(
      (t) => t.uuid !== trace.uuid,
    );

    const targetTraceName =
      this.controller.traces.find(
        (t) => t.uuid === config.syncClock?.toTraceUuid,
      )?.file.name ?? 'Not set';

    return [
      this.renderDetailRow(
        'Source Clock',
        isManual
          ? this.renderSourceClockSelector(trace)
          : m(
              'span.pf-multi-trace-modal__static-select',
              config.syncClock?.fromClock ?? 'Not set',
            ),
      ),
      this.renderDetailRow(
        'Target Trace',
        isManual
          ? this.renderTargetTraceSelector(trace, otherTraces)
          : m('span.pf-multi-trace-modal__static-select', targetTraceName),
      ),
      this.renderDetailRow(
        'Target Clock',
        isManual
          ? this.renderTargetClockSelector(trace)
          : m(
              'span.pf-multi-trace-modal__static-select',
              config.syncClock?.toClock ?? 'Not set',
            ),
      ),
    ];
  }

  private renderDetailRow(label: string, content: m.Children) {
    return m(
      Stack,
      {className: 'pf-multi-trace-modal__form-group'},
      m('label', label),
      content,
    );
  }

  private renderRoleSelector(trace: TraceFileAnalyzed) {
    return m(
      Select,
      {
        value: trace.syncConfig.syncMode,
        onchange: (e: Event) => {
          const target = e.target as HTMLSelectElement;
          const newSyncMode = target.value as SyncConfig['syncMode'];
          if (newSyncMode === 'ROOT') {
            trace.syncConfig = {
              syncMode: 'ROOT',
              rootClock: '',
            };
          } else {
            trace.syncConfig = {
              syncMode: 'SYNC_TO_OTHER',
            };
          }
          this.controller.recomputeSync();
          redrawModal();
        },
      },
      m('option', {value: 'ROOT'}, 'Root clock provider'),
      m('option', {value: 'SYNC_TO_OTHER'}, 'Synced to another trace'),
    );
  }

  private renderRootClockSelector(trace: TraceFileAnalyzed) {
    if (trace.syncConfig.syncMode !== 'ROOT') return;
    return m(
      Select,
      {
        value: trace.syncConfig.rootClock,
        onchange: (e: Event) => {
          const target = e.target as HTMLSelectElement;
          trace.syncConfig = {
            syncMode: 'ROOT',
            rootClock: target.value,
          };
          this.controller.recomputeSync();
        },
      },
      m('option', {value: ''}, 'Select a clock'),
      trace.clocks.map((clock) => m('option', {value: clock.name}, clock.name)),
    );
  }

  private renderSourceClockSelector(trace: TraceFileAnalyzed) {
    const syncConfig = trace.syncConfig;
    if (syncConfig.syncMode !== 'SYNC_TO_OTHER') return;
    return m(
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
          this.controller.recomputeSync();
        },
      },
      m('option', {value: ''}, 'Select a clock'),
      (trace.clocks ?? []).map((clock) =>
        m('option', {value: clock.name}, clock.name),
      ),
    );
  }

  private renderTargetTraceSelector(
    trace: TraceFileAnalyzed,
    otherTraces: TraceFile[],
  ) {
    const syncConfig = trace.syncConfig;
    if (syncConfig.syncMode !== 'SYNC_TO_OTHER') return;
    return m(
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
          this.controller.recomputeSync();
          redrawModal();
        },
      },
      m('option', {value: ''}, 'Select a trace'),
      otherTraces.map((other) =>
        m('option', {value: other.uuid}, other.file.name),
      ),
    );
  }

  private renderTargetClockSelector(trace: TraceFileAnalyzed) {
    const syncConfig = trace.syncConfig;
    if (syncConfig.syncMode !== 'SYNC_TO_OTHER') return;

    const isTargetTraceSelected = !!syncConfig.syncClock?.toTraceUuid;

    const targetTrace = isTargetTraceSelected
      ? (this.controller.traces.find(
          (t) => t.uuid === syncConfig.syncClock?.toTraceUuid,
        ) as TraceFileAnalyzed | undefined)
      : undefined;

    return m(
      Select,
      {
        disabled: !isTargetTraceSelected,
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
          this.controller.recomputeSync();
        },
      },
      isTargetTraceSelected
        ? [
            m('option', {value: ''}, 'Select a clock'),
            (targetTrace?.clocks ?? []).map((clock) =>
              m('option', {value: clock.name}, clock.name),
            ),
          ]
        : m(
            'option',
            {value: '', disabled: true, selected: true},
            'Select a target trace first',
          ),
    );
  }

  private renderSyncModeSelector(trace: TraceFileAnalyzed) {
    return this.renderDetailRow(
      'Sync Mode',
      m(Switch, {
        label: 'Automatic',
        labelLeft: 'Manual',
        checked: trace.syncMode === 'AUTOMATIC',
        onchange: (e: Event) => {
          const target = e.target as HTMLInputElement;
          trace.syncMode = target.checked ? 'AUTOMATIC' : 'MANUAL';
          this.controller.recomputeSync();
        },
      }),
    );
  }

  private renderActions() {
    const syncError = this.controller.syncError;
    const isDisabled =
      !areAllTracesAnalyzed(this.controller.traces) ||
      this.controller.traces.length === 0 ||
      !!syncError;

    const tooltipText = syncError ?? getTooltipText(this.controller.traces);

    const openButton = this.renderOpenTracesButton(isDisabled);

    return [
      syncError &&
        m(
          '.pf-multi-trace-modal__error',
          m(Icon, {icon: 'error_outline'}),
          syncError,
        ),
      m(
        Tooltip,
        {
          className: 'pf-multi-trace-modal__open-traces-tooltip',
          trigger: openButton,
        },
        tooltipText,
      ),
    ];
  }

  // Sub-Renderers
  private renderTraceItem(trace: TraceFile) {
    return m(
      CardStack,
      {
        className: 'pf-multi-trace-modal__card',
        direction: 'horizontal',
        key: trace.uuid,
      },
      this.renderTraceInfo(trace),
      this.renderCardActions(trace.uuid),
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

  private renderCardActions(uuid: string) {
    return m(
      '.pf-multi-trace-modal__actions',
      m(Button, {
        icon: 'edit',
        onclick: () => this.controller.selectTrace(uuid),
      }),
      m(Button, {
        icon: 'delete',
        onclick: () => this.controller.removeTrace(uuid),
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
        spacing: 'small',
      },
      trace.status === 'analyzing' && m(Spinner),
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

export function showMultiTraceModal(initialFiles: ReadonlyArray<File>) {
  showModal({
    title: 'Open Multiple Traces',
    icon: 'library_books',
    key: MODAL_KEY,
    className: 'pf-multi-trace-modal-override',
    content: () => m(MultiTraceModalComponent, {initialFiles}),
  });
}

function getTooltipText(traces: ReadonlyArray<TraceFile>): string {
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

function areAllTracesAnalyzed(traces: ReadonlyArray<TraceFile>): boolean {
  return traces.every((trace) => trace.status === 'analyzed');
}

function isAnalyzing(traces: ReadonlyArray<TraceFile>): boolean {
  return traces.some((trace) => trace.status === 'analyzing');
}
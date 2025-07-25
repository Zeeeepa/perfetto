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

import {
  SyncConfig,
  TraceFile,
  TraceFileAnalyzed,
} from './multi_trace_types';
import {uuidv4} from '../../base/uuid';
import {redrawModal} from '../../widgets/modal';
import {assertExists} from '../../base/logging';
import {TraceAnalyzer} from './trace_analyzer';

function getErrorMessage(e: unknown): string {
  const err = e instanceof Error ? e.message : `${e}`;
  if (err.includes('(ERR:fmt)')) {
    return `The file opened doesn't look like a Perfetto trace or any other supported trace format.`;
  }
  return err;
}

const PREFERRED_ROOT_CLOCKS = [
  'BOOTTIME',
  'MONOTONIC',
  'MONOTONIC_RAW',
  'MONOTONIC_COARSE',
  'TSC',
  'REALTIME',
  'REALTIME_COARSE',
  'PERF',
];

interface TraceFileWrapper {
  trace: TraceFile;
}

export class MultiTraceController {
  private wrappers: TraceFileWrapper[] = [];
  private selectedUuid?: string;
  private traceAnalyzer: TraceAnalyzer;
  syncError?: string;

  constructor(traceAnalyzer: TraceAnalyzer) {
    this.traceAnalyzer = traceAnalyzer;
  }

  get traces(): ReadonlyArray<TraceFile> {
    return this.wrappers.map((x) => x.trace);
  }

  get selectedTrace(): Readonly<TraceFile> | undefined {
    return this.wrappers.find((w) => w.trace.uuid === this.selectedUuid)?.trace;
  }

  async addFiles(files: ReadonlyArray<File>) {
    const newTraces: TraceFileWrapper[] = Array.from(files).map((file) => ({
      trace: {
        file,
        uuid: uuidv4(),
        status: 'not-analyzed',
      },
    }));
    this.wrappers.push(...newTraces);
    await Promise.all(newTraces.map((trace) => this.analyzeTrace(trace)));
    this.recomputeSync();
    redrawModal();
  }

  selectTrace(uuid: string) {
    this.selectedUuid = uuid;
  }

  removeTrace(uuid: string) {
    const index = this.wrappers.findIndex((w) => w.trace.uuid === uuid);
    if (index > -1) {
      this.wrappers.splice(index, 1);
    }
    if (this.selectedUuid === uuid) {
      this.selectedUuid = undefined;
    }
    this.recomputeSync();
    redrawModal();
  }

  recomputeSync() {
    this.syncError = undefined;

    const analyzedTraces = this.wrappers
      .map(({trace}) => trace)
      .filter((trace): trace is TraceFileAnalyzed => {
        return trace.status === 'analyzed';
      });

    const manualTraces = analyzedTraces.filter(
      (trace) => trace.syncMode === 'MANUAL',
    );
    const automaticTraces = analyzedTraces.filter(
      (trace) => trace.syncMode === 'AUTOMATIC',
    );

    const manualRoots = manualTraces.filter(
      (trace) => trace.syncConfig.syncMode === 'ROOT',
    );

    if (manualRoots.length > 1) {
      this.syncError = 'Multiple manual root traces are not allowed.';
      redrawModal();
      return;
    }

    const adj = new Map<string, string[]>();
    const clocksByUuid = new Map<string, Set<string>>();
    for (const trace of analyzedTraces) {
      adj.set(trace.uuid, []);
      clocksByUuid.set(trace.uuid, new Set(trace.clocks.map((c) => c.name)));
    }

    for (let i = 0; i < analyzedTraces.length; i++) {
      for (let j = i + 1; j < analyzedTraces.length; j++) {
        const traceA = analyzedTraces[i];
        const traceB = analyzedTraces[j];
        const clocksA = assertExists(clocksByUuid.get(traceA.uuid));
        const clocksB = assertExists(clocksByUuid.get(traceB.uuid));
        if (
          [...clocksA].some((clock) => clocksB.has(clock))
        ) {
          adj.get(traceA.uuid)!.push(traceB.uuid);
          adj.get(traceB.uuid)!.push(traceA.uuid);
        }
      }
    }

    let rootUuid: string | undefined =
      manualRoots.length === 1 ? manualRoots[0].uuid : undefined;

    if (!rootUuid && automaticTraces.length > 0) {
      for (const clock of PREFERRED_ROOT_CLOCKS) {
        const traceWithClock = automaticTraces.find((t) =>
          clocksByUuid.get(t.uuid)!.has(clock),
        );
        if (traceWithClock) {
          rootUuid = traceWithClock.uuid;
          break;
        }
      }
      if (!rootUuid) {
        rootUuid = automaticTraces.reduce((a, b) =>
          (adj.get(a.uuid)!.length > adj.get(b.uuid)!.length ? a : b),
        ).uuid;
      }
    }

    const newConfigs = new Map<string, SyncConfig>();
    if (rootUuid) {
      const queue: string[] = [rootUuid];
      const visited = new Set<string>([rootUuid]);
      const rootTrace = analyzedTraces.find((t) => t.uuid === rootUuid)!;
      if (rootTrace.syncMode === 'AUTOMATIC') {
        const rootTraceClocks = clocksByUuid.get(rootUuid)!;
        const bestClock = PREFERRED_ROOT_CLOCKS.find((c) =>
          rootTraceClocks.has(c),
        );
        newConfigs.set(rootUuid, {
          syncMode: 'ROOT',
          rootClock: bestClock ?? rootTrace.clocks[0]?.name ?? '',
        });
      }

      while (queue.length > 0) {
        const parentUuid = queue.shift()!;
        for (const childUuid of adj.get(parentUuid)!) {
          if (visited.has(childUuid)) continue;
          visited.add(childUuid);
          const childTrace = analyzedTraces.find((t) => t.uuid === childUuid)!;
          if (childTrace.syncMode === 'MANUAL') continue;

          const parentClocks = clocksByUuid.get(parentUuid)!;
          const childClocks = clocksByUuid.get(childUuid)!;
          const bestCommonClock = PREFERRED_ROOT_CLOCKS.find(
            (c) => parentClocks.has(c) && childClocks.has(c),
          );

          if (bestCommonClock) {
            newConfigs.set(childUuid, {
              syncMode: 'SYNC_TO_OTHER',
              syncClock: {
                fromClock: bestCommonClock,
                toTraceUuid: parentUuid,
                toClock: bestCommonClock,
              },
            });
            queue.push(childUuid);
          }
        }
      }
    }

    for (const trace of automaticTraces) {
      const newConfig = newConfigs.get(trace.uuid);
      if (newConfig) {
        trace.syncConfig = newConfig;
      } else {
        trace.syncConfig = {
          syncMode: 'ROOT',
          rootClock: trace.clocks[0]?.name ?? '',
        };
      }
    }
    redrawModal();
  }

  private async analyzeTrace(wrapper: TraceFileWrapper) {
    if (wrapper.trace.status !== 'not-analyzed') {
      return;
    }
    wrapper.trace = {
      ...wrapper.trace,
      status: 'analyzing',
      progress: 0,
    };
    redrawModal();
    try {
      const result = await this.traceAnalyzer.analyze(
        wrapper.trace.file,
        (progress) => {
          if (wrapper.trace.status === 'analyzing') {
            wrapper.trace.progress = progress;
            redrawModal();
          }
        },
      );

      wrapper.trace = {
        ...wrapper.trace,
        status: 'analyzed',
        format: result.format,
        clocks: result.clocks,
        syncMode: 'AUTOMATIC',
        syncConfig: {
          syncMode: 'ROOT',
          rootClock: '',
        },
      };
    } catch (e) {
      wrapper.trace = {
        ...wrapper.trace,
        status: 'error',
        error: getErrorMessage(e),
      };
    }
  }
}

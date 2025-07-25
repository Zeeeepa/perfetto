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
  ClockInfo,
  SyncConfig,
  TraceFile,
  TraceFileAnalyzed,
} from './multi_trace_types';
import {WasmEngineProxy} from '../../trace_processor/wasm_engine_proxy';
import {uuidv4} from '../../base/uuid';
import {redrawModal} from '../../widgets/modal';
import {TraceFileStream} from '../../core/trace_stream';
import {NUM, STR} from '../../trace_processor/query_result';
import {assertExists} from '../../base/logging';

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

interface TraceFileWrapper {
  trace: TraceFile;
}

export class MultiTraceController {
  private wrappers: TraceFileWrapper[] = [];
  private selectedUuid?: string;
  syncError?: string;

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

    // Validate manual configurations
    const manualRoots = manualTraces.filter(
      (trace) => trace.syncConfig.syncMode === 'ROOT',
    );

    if (manualRoots.length > 1) {
      this.syncError = 'Multiple manual root traces are not allowed.';
      redrawModal();
      return;
    }

    // Build a graph of all analyzed traces
    const adj: Map<string, string[]> = new Map();
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
        const commonClocks = [...clocksA].filter((clock) =>
          clocksB.has(clock),
        );
        if (commonClocks.length > 0) {
          assertExists(adj.get(traceA.uuid)).push(traceB.uuid);
          assertExists(adj.get(traceB.uuid)).push(traceA.uuid);
        }
      }
    }

    // Determine the root trace
    let rootUuid: string | undefined = undefined;
    if (manualRoots.length === 1) {
      rootUuid = manualRoots[0].uuid;
    } else if (analyzedTraces.length > 0) {
      // Heuristic: pick the trace with the most connections as the root.
      // Only consider automatic traces for this heuristic if there's no manual
      // root.
      const tracesForHeuristic =
        automaticTraces.length > 0 ? automaticTraces : analyzedTraces;
      if (tracesForHeuristic.length > 0) {
        rootUuid = tracesForHeuristic.reduce((a, b) => {
          return (adj.get(a.uuid)?.length ?? 0) >
            (adj.get(b.uuid)?.length ?? 0)
            ? a
            : b;
        }).uuid;
      }
    }

    if (!rootUuid) {
      // No traces or no connections, give all automatic traces a default ROOT
      // config
      for (const trace of automaticTraces) {
        trace.syncConfig = {
          syncMode: 'ROOT',
          rootClock: trace.clocks[0]?.name ?? '',
        };
      }
      redrawModal();
      return;
    }

    // Traverse the graph with BFS to build sync configs
    const queue: Array<{uuid: string; parentUuid: string | null}> = [
      {uuid: rootUuid, parentUuid: null},
    ];
    const visited: Set<string> = new Set([rootUuid]);
    const newConfigs = new Map<string, SyncConfig>();

    // Set root config for the root trace if it's in automatic mode
    const rootTrace = analyzedTraces.find((t) => t.uuid === rootUuid)!;
    if (rootTrace.syncMode === 'AUTOMATIC') {
      newConfigs.set(rootUuid, {
        syncMode: 'ROOT',
        rootClock: rootTrace.clocks[0]?.name ?? '', // Default to first clock
      });
    }

    while (queue.length > 0) {
      const {uuid: parentUuid} = queue.shift()!;
      const neighbors = adj.get(parentUuid) ?? [];

      for (const childUuid of neighbors) {
        if (!visited.has(childUuid)) {
          visited.add(childUuid);

          const childTrace = analyzedTraces.find((t) => t.uuid === childUuid)!;
          // Only configure automatic traces
          if (childTrace.syncMode === 'AUTOMATIC') {
            const parentClocks = assertExists(clocksByUuid.get(parentUuid));
            const childClocks = assertExists(clocksByUuid.get(childUuid));
            const commonClock = [...parentClocks].find((clock) =>
              childClocks.has(clock),
            );

            if (commonClock) {
              newConfigs.set(childUuid, {
                syncMode: 'SYNC_TO_OTHER',
                syncClock: {
                  fromClock: commonClock,
                  toTraceUuid: parentUuid,
                  toClock: commonClock,
                },
              });
            }
          }
          queue.push({uuid: childUuid, parentUuid: parentUuid});
        }
      }
    }

    // Apply the new configs to automatic traces
    for (const trace of automaticTraces) {
      const newConfig = newConfigs.get(trace.uuid);
      if (newConfig) {
        trace.syncConfig = newConfig;
      } else {
        // This trace is not connected to the main graph.
        // Make it a root.
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
      using engine = new WasmEngineProxy(uuidv4());
      engine.resetTraceProcessor({
        tokenizeOnly: true,
        cropTrackEvents: false,
        ingestFtraceInRawTable: false,
        analyzeTraceProtoContent: false,
        ftraceDropUntilAllCpusValid: false,
      });
      const stream = new TraceFileStream(wrapper.trace.file);
      for (;;) {
        const res = await stream.readChunk();
        wrapper.trace.progress = res.bytesRead / wrapper.trace.file.size;
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
        wrapper.trace = {
          ...wrapper.trace,
          status: 'error',
          error:
            'This trace contains multiple sub-traces, which is not supported because recursive synchronization is tricky. Please open each sub-trace individually.',
        };
        return;
      }
      if (leafNodes.length === 0) {
        wrapper.trace = {
          ...wrapper.trace,
          status: 'error',
          error: 'Could not determine trace type',
        };
        return;
      }

      // Also query for the clocks in this trace
      const clocksResult = await engine.query(`
          SELECT clock_name, COUNT(*) as count
          FROM clock_snapshot
          WHERE clock_name IS NOT NULL
          GROUP BY clock_name
          ORDER BY count DESC
        `);
      const clocks: ClockInfo[] = [];
      const clockIt = clocksResult.iter({clock_name: STR, count: NUM});
      for (; clockIt.valid(); clockIt.next()) {
        clocks.push({name: clockIt.clock_name, count: clockIt.count});
      }
      wrapper.trace = {
        ...wrapper.trace,
        status: 'analyzed',
        format: mapTraceType(leafNodes[0]),
        clocks: clocks,
        syncMode: 'AUTOMATIC',
        // Default config, will be overwritten by recomputeSync
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

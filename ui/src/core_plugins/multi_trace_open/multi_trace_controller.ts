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

import {TraceFile, ClockInfo} from './multi_trace_types';
import {WasmEngineProxy} from '../../trace_processor/wasm_engine_proxy';
import {uuidv4} from '../../base/uuid';
import {redrawModal} from '../../widgets/modal';
import {TraceFileStream} from '../../core/trace_stream';
import {NUM, STR} from '../../trace_processor/query_result';

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

export class MultiTraceController {
  traces: TraceFile[] = [];
  selectedTrace?: TraceFile;

  async addFiles(files: ReadonlyArray<File>) {
    const newTraces: TraceFile[] = Array.from(files).map((file) => ({
      file,
      uuid: uuidv4(),
      status: 'not-analyzed',
    }));
    this.traces.push(...newTraces);
    await Promise.all(newTraces.map((trace) => this.analyzeTrace(trace)));
    redrawModal();
  }

  removeTrace(index: number) {
    const removedTrace = this.traces[index];
    this.traces.splice(index, 1);
    if (this.selectedTrace === removedTrace) {
      this.selectedTrace = undefined;
    }
    redrawModal();
  }

  private async analyzeTrace(trace: TraceFile) {
    if (trace.status !== 'not-analyzed') {
      return;
    }
    trace = {
      ...trace,
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
      const stream = new TraceFileStream(trace.file);
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
        trace = {
          ...trace,
          status: 'error',
          error:
            'This trace contains multiple sub-traces, which is not supported because recursive synchronization is tricky. Please open each sub-trace individually.',
        };
        return;
      }
      if (leafNodes.length === 0) {
        trace = {
          ...trace,
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
      trace = {
        ...trace,
        status: 'analyzed',
        format: mapTraceType(leafNodes[0]),
        clocks: clocks,
        syncMode: 'AUTOMATIC',
        syncConfig: {
          syncMode: 'SYNC_TO_OTHER',
        },
      };
    } catch (e) {
      trace = {
        ...trace,
        status: 'error',
        error: getErrorMessage(e),
      };
    } finally {
      redrawModal();
    }
  }
}

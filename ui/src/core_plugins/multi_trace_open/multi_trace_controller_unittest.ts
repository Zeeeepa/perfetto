// Copyright (C) 2025 The Android Open Source Project
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

import {MultiTraceController} from './multi_trace_controller';
import {TraceFileAnalyzed} from './multi_trace_types';
import {TraceAnalysisResult, TraceAnalyzer} from './trace_analyzer';

// Mocking the modal redraw function as it's not needed for controller logic
// tests and relies on a real DOM.
jest.mock('../../widgets/modal', () => ({
  redrawModal: jest.fn(),
}));

// Helper to create a mock TraceFileAnalyzed object for manual mode tests
function createMockTrace(
  uuid: string,
  clocks: string[],
  syncMode: 'AUTOMATIC' | 'MANUAL' = 'AUTOMATIC',
): TraceFileAnalyzed {
  return {
    uuid,
    file: new File([], `${uuid}.pftrace`),
    status: 'analyzed',
    format: 'Perfetto',
    clocks: clocks.map((name) => ({name, count: 100})),
    syncMode,
    syncConfig: {syncMode: 'ROOT', rootClock: ''}, // Default config
  };
}

// A fake TraceAnalyzer for testing purposes.
class FakeTraceAnalyzer implements TraceAnalyzer {
  private results = new Map<string, TraceAnalysisResult>();
  private errors = new Map<string, Error>();

  setResult(fileName: string, result: TraceAnalysisResult) {
    this.results.set(fileName, result);
  }

  setError(fileName: string, error: Error) {
    this.errors.set(fileName, error);
  }

  async analyze(
    file: File,
    _onProgress: (progress: number) => void,
  ): Promise<TraceAnalysisResult> {
    if (this.errors.has(file.name)) {
      throw this.errors.get(file.name)!;
    }
    const result = this.results.get(file.name);
    if (result) {
      return result;
    }
    throw new Error(`No mock result set for ${file.name}`);
  }
}

// Helper to create a File object for tests
function createMockFile(name: string): File {
  return new File([], name);
}

describe('MultiTraceController', () => {
  let controller: MultiTraceController;
  let fakeAnalyzer: FakeTraceAnalyzer;

  beforeEach(() => {
    fakeAnalyzer = new FakeTraceAnalyzer();
    controller = new MultiTraceController(fakeAnalyzer);
  });

  it('should initialize with no traces or errors', () => {
    expect(controller.traces).toHaveLength(0);
    expect(controller.syncError).toBeUndefined();
  });

  it('should set a single trace as a root', async () => {
    const file = createMockFile('trace1.pftrace');
    fakeAnalyzer.setResult(file.name, {
      format: 'Perfetto',
      clocks: [{name: 'BOOTTIME', count: 1}],
    });

    await controller.addFiles([file]);

    const trace = controller.traces[0] as TraceFileAnalyzed;
    expect(trace.syncConfig.syncMode).toEqual('ROOT');
  });

  it('should sync two traces based on preferred clock order', async () => {
    const file1 = createMockFile('trace1.pftrace');
    const file2 = createMockFile('trace2.pftrace');
    // trace1 has a lower priority clock
    fakeAnalyzer.setResult(file1.name, {
      format: 'Perfetto',
      clocks: [{name: 'MONOTONIC', count: 1}],
    });
    // trace2 has a higher priority clock
    fakeAnalyzer.setResult(file2.name, {
      format: 'Perfetto',
      clocks: [{name: 'BOOTTIME', count: 1}],
    });

    await controller.addFiles([file1, file2]);

    const trace1 = controller.traces.find(
      (t) => t.file.name === file1.name,
    ) as TraceFileAnalyzed;
    const trace2 = controller.traces.find(
      (t) => t.file.name === file2.name,
    ) as TraceFileAnalyzed;

    // Trace 2 should be root as it has the higher priority clock
    expect(trace2.syncConfig.syncMode).toEqual('ROOT');
    // In this specific test, they can't sync, so trace1 will also be a root.
    expect(trace1.syncConfig.syncMode).toEqual('ROOT');
  });

  it('should select the highest priority clock for a single root trace', async () => {
    const file = createMockFile('trace1.pftrace');
    const clocks = [
      {name: 'REALTIME_COARSE', count: 1},
      {name: 'REALTIME', count: 1},
      {name: 'MONOTONIC_RAW', count: 1},
      {name: 'MONOTONIC_COARSE', count: 1},
      {name: 'MONOTONIC', count: 1},
      {name: 'BOOTTIME', count: 1},
    ];
    fakeAnalyzer.setResult(file.name, {format: 'Perfetto', clocks});

    await controller.addFiles([file]);

    const trace = controller.traces[0] as TraceFileAnalyzed;
    expect(trace.syncConfig.syncMode).toEqual('ROOT');
    if (trace.syncConfig.syncMode === 'ROOT') {
      expect(trace.syncConfig.rootClock).toEqual('BOOTTIME');
    }
  });

  it('should choose the highest priority common clock for sync', async () => {
    const file1 = createMockFile('trace1.pftrace');
    const file2 = createMockFile('trace2.pftrace');
    // Both traces share a high and low priority clock
    const clocks = [
      {name: 'REALTIME_COARSE', count: 1},
      {name: 'BOOTTIME', count: 1},
    ];
    fakeAnalyzer.setResult(file1.name, {format: 'Perfetto', clocks});
    fakeAnalyzer.setResult(file2.name, {format: 'Perfetto', clocks});

    await controller.addFiles([file1, file2]);

    const trace1 = controller.traces[0] as TraceFileAnalyzed;
    const trace2 = controller.traces[1] as TraceFileAnalyzed;

    // Assuming trace1 becomes the root
    const syncTrace = trace1.syncConfig.syncMode === 'ROOT' ? trace2 : trace1;
    const rootTrace = trace1.syncConfig.syncMode === 'ROOT' ? trace1 : trace2;

    expect(syncTrace.syncConfig.syncMode).toEqual('SYNC_TO_OTHER');
    if (syncTrace.syncConfig.syncMode === 'SYNC_TO_OTHER') {
      expect(syncTrace.syncConfig.syncClock?.toTraceUuid).toEqual(
        rootTrace.uuid,
      );
      // This is the key check: it must use the best clock.
      expect(syncTrace.syncConfig.syncClock?.fromClock).toEqual('BOOTTIME');
      expect(syncTrace.syncConfig.syncClock?.toClock).toEqual('BOOTTIME');
    } else {
      fail('One trace should be syncing to the other');
    }
  });

  it('should handle multiple disconnected traces', async () => {
    const file1 = createMockFile('trace1.pftrace');
    const file2 = createMockFile('trace2.pftrace');
    fakeAnalyzer.setResult(file1.name, {
      format: 'Perfetto',
      clocks: [{name: 'BOOTTIME', count: 1}],
    });
    fakeAnalyzer.setResult(file2.name, {
      format: 'Perfetto',
      clocks: [{name: 'MONOTONIC', count: 1}],
    });

    await controller.addFiles([file1, file2]);

    const trace1 = controller.traces[0] as TraceFileAnalyzed;
    const trace2 = controller.traces[1] as TraceFileAnalyzed;

    // Both should become roots as they can't be synced
    expect(trace1.syncConfig.syncMode).toEqual('ROOT');
    expect(trace2.syncConfig.syncMode).toEqual('ROOT');
  });

  it('should respect a manual root', () => {
    const trace1 = createMockTrace('uuid1', ['BOOTTIME']);
    const trace2 = createMockTrace('uuid2', ['BOOTTIME'], 'MANUAL');
    trace2.syncConfig = {syncMode: 'ROOT', rootClock: 'BOOTTIME'};
    (controller as any).wrappers = [{trace: trace1}, {trace: trace2}];

    controller.recomputeSync();

    // trace2 is the manual root, so trace1 must sync to it
    expect(trace1.syncConfig.syncMode).toEqual('SYNC_TO_OTHER');
    if (trace1.syncConfig.syncMode === 'SYNC_TO_OTHER') {
      expect(trace1.syncConfig.syncClock?.toTraceUuid).toEqual('uuid2');
    }
  });

  it('should detect and report multiple manual roots', () => {
    const trace1 = createMockTrace('uuid1', ['BOOTTIME'], 'MANUAL');
    trace1.syncConfig = {syncMode: 'ROOT', rootClock: 'BOOTTIME'};
    const trace2 = createMockTrace('uuid2', ['MONOTONIC'], 'MANUAL');
    trace2.syncConfig = {syncMode: 'ROOT', rootClock: 'MONOTONIC'};
    (controller as any).wrappers = [{trace: trace1}, {trace: trace2}];

    controller.recomputeSync();

    expect(controller.syncError).toEqual(
      'Multiple manual root traces are not allowed.',
    );
  });

  it('should respect a manual sync configuration', () => {
    const trace1 = createMockTrace('uuid1', ['BOOTTIME']);
    const trace2 = createMockTrace('uuid2', ['MONOTONIC'], 'MANUAL');
    const trace3 = createMockTrace('uuid3', ['MONOTONIC']);

    trace2.syncConfig = {
      syncMode: 'SYNC_TO_OTHER',
      syncClock: {
        fromClock: 'MONOTONIC',
        toTraceUuid: 'uuid1',
        toClock: 'BOOTTIME',
      },
    };
    (controller as any).wrappers = [
      {trace: trace1},
      {trace: trace2},
      {trace: trace3},
    ];

    controller.recomputeSync();

    expect(trace1.syncConfig.syncMode).toEqual('ROOT');
    if (trace2.syncConfig.syncMode === 'SYNC_TO_OTHER') {
      expect(trace2.syncConfig.syncClock?.toTraceUuid).toEqual('uuid1');
    }
    if (trace3.syncConfig.syncMode === 'SYNC_TO_OTHER') {
      expect(trace3.syncConfig.syncClock?.toTraceUuid).toEqual('uuid2');
      expect(trace3.syncConfig.syncClock?.fromClock).toEqual('MONOTONIC');
    }
  });
});
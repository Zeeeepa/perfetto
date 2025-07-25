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

// Mocking the modal redraw function as it's not needed for controller logic
// tests and relies on a real DOM.
jest.mock('../../widgets/modal', () => ({
  redrawModal: jest.fn(),
}));

// Helper to create a mock TraceFileAnalyzed object
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

describe('MultiTraceController', () => {
  let controller: MultiTraceController;
  let mockAnalyzeTrace: jest.SpyInstance;

  beforeEach(() => {
    controller = new MultiTraceController();
    // We mock analyzeTrace to avoid dealing with WasmEngineProxy and file
    // streams. We can directly set the result of the analysis.
    mockAnalyzeTrace = jest
      .spyOn(controller as any, 'analyzeTrace')
      .mockImplementation(async (wrapper: {trace: TraceFileAnalyzed}) => {
        // The "analysis" is essentially just accepting the mock trace data.
        // The wrapper's trace is already a TraceFileAnalyzed in our tests.
      });
  });

  afterEach(() => {
    mockAnalyzeTrace.mockRestore();
  });

  it('should initialize with no traces or errors', () => {
    expect(controller.traces).toHaveLength(0);
    expect(controller.syncError).toBeUndefined();
  });

  it('should set a single trace as a root', async () => {
    const trace = createMockTrace('uuid1', ['boottime']);
    (controller as any).wrappers = [{trace}];
    controller.recomputeSync();
    expect(trace.syncConfig.syncMode).toEqual('ROOT');
  });

  it('should sync two traces with a common clock', async () => {
    const trace1 = createMockTrace('uuid1', ['boottime', 'monotonic']);
    const trace2 = createMockTrace('uuid2', ['boottime']);
    (controller as any).wrappers = [{trace: trace1}, {trace: trace2}];

    controller.recomputeSync();

    // Trace 1 should be root as it has more clocks/connections
    expect(trace1.syncConfig.syncMode).toEqual('ROOT');
    // Trace 2 should sync to trace 1
    expect(trace2.syncConfig.syncMode).toEqual('SYNC_TO_OTHER');
    expect(trace2.syncConfig.syncClock?.toTraceUuid).toEqual('uuid1');
    expect(trace2.syncConfig.syncClock?.fromClock).toEqual('boottime');
    expect(trace2.syncConfig.syncClock?.toClock).toEqual('boottime');
  });

  it('should handle multiple disconnected traces', async () => {
    const trace1 = createMockTrace('uuid1', ['boottime']);
    const trace2 = createMockTrace('uuid2', ['monotonic']);
    (controller as any).wrappers = [{trace: trace1}, {trace: trace2}];

    controller.recomputeSync();

    // Both should become roots as they can't be synced
    expect(trace1.syncConfig.syncMode).toEqual('ROOT');
    expect(trace2.syncConfig.syncMode).toEqual('ROOT');
  });

  it('should respect a manual root', async () => {
    const trace1 = createMockTrace('uuid1', ['boottime']);
    const trace2 = createMockTrace('uuid2', ['boottime'], 'MANUAL');
    trace2.syncConfig = {syncMode: 'ROOT', rootClock: 'boottime'};
    (controller as any).wrappers = [{trace: trace1}, {trace: trace2}];

    controller.recomputeSync();

    // trace2 is the manual root, so trace1 must sync to it
    expect(trace1.syncConfig.syncMode).toEqual('SYNC_TO_OTHER');
    expect(trace1.syncConfig.syncClock?.toTraceUuid).toEqual('uuid2');
  });

  it('should detect and report multiple manual roots', async () => {
    const trace1 = createMockTrace('uuid1', ['boottime'], 'MANUAL');
    trace1.syncConfig = {syncMode: 'ROOT', rootClock: 'boottime'};
    const trace2 = createMockTrace('uuid2', ['monotonic'], 'MANUAL');
    trace2.syncConfig = {syncMode: 'ROOT', rootClock: 'monotonic'};
    (controller as any).wrappers = [{trace: trace1}, {trace: trace2}];

    controller.recomputeSync();

    expect(controller.syncError).toEqual(
      'Multiple manual root traces are not allowed.',
    );
  });

  it('should respect a manual sync configuration', async () => {
    const trace1 = createMockTrace('uuid1', ['boottime']);
    const trace2 = createMockTrace('uuid2', ['monotonic'], 'MANUAL');
    const trace3 = createMockTrace('uuid3', ['monotonic']);

    // Manual config: trace2 syncs to trace1 via a non-existent clock
    // (to prove the algorithm respects it)
    trace2.syncConfig = {
      syncMode: 'SYNC_TO_OTHER',
      syncClock: {
        fromClock: 'monotonic',
        toTraceUuid: 'uuid1',
        toClock: 'boottime',
      },
    };
    (controller as any).wrappers = [
      {trace: trace1},
      {trace: trace2},
      {trace: trace3},
    ];

    controller.recomputeSync();

    // trace1 is root
    expect(trace1.syncConfig.syncMode).toEqual('ROOT');
    // trace2 config should be untouched
    expect(trace2.syncConfig.syncClock?.toTraceUuid).toEqual('uuid1');
    // trace3 should sync to trace2 as they share a 'monotonic' clock
    expect(trace3.syncConfig.syncMode).toEqual('SYNC_TO_OTHER');
    expect(trace3.syncConfig.syncClock?.toTraceUuid).toEqual('uuid2');
    expect(trace3.syncConfig.syncClock?.fromClock).toEqual('monotonic');
  });

  it('should preserve config when switching to manual', async () => {
    const trace1 = createMockTrace('uuid1', ['boottime']);
    const trace2 = createMockTrace('uuid2', ['boottime']);
    (controller as any).wrappers = [{trace: trace1}, {trace: trace2}];

    controller.recomputeSync();

    // Capture the automatic config for trace2
    const autoConfig = {...trace2.syncConfig};
    expect(autoConfig.syncMode).toEqual('SYNC_TO_OTHER');

    // Switch to manual
    trace2.syncMode = 'MANUAL';
    controller.recomputeSync();

    // The config should be identical
    expect(trace2.syncConfig).toEqual(autoConfig);
  });
});

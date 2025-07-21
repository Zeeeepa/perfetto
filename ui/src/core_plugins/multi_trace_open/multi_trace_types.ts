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

export interface TraceFileBase {
  uuid: string;
  file: File;
}

export interface TraceFileNotAnalyzed extends TraceFileBase {
  status: 'not-analyzed';
}

export interface TraceFileAnalyzing extends TraceFileBase {
  status: 'analyzing';
  progress: number;
}

export interface SyncConfigRoot {
  syncMode: 'ROOT';
  rootClock: string;
}

export interface SyncConfigOther {
  syncMode: 'SYNC_TO_OTHER';
  syncClock?: {
    fromClock: string;
    toTraceUuid: string;
    toClock: string;
  };
}

export type SyncConfig = SyncConfigRoot | SyncConfigOther;

export interface ClockInfo {
  name: string;
  count: number;
}

export interface TraceFileAnalyzed extends TraceFileBase {
  status: 'analyzed';
  format: string;
  clocks: ClockInfo[];
  syncMode: 'AUTOMATIC' | 'MANUAL';
  syncConfig: SyncConfig;
}

export interface TraceFileError extends TraceFileBase {
  status: 'error';
  error: string;
}

export type TraceFile =
  | TraceFileNotAnalyzed
  | TraceFileAnalyzing
  | TraceFileAnalyzed
  | TraceFileError;

export type TraceStatus = TraceFile['status'];

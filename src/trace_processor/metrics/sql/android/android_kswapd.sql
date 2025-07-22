--
-- Copyright 2025 The Android Open Source Project
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--
INCLUDE PERFETTO MODULE android.memory.kswapd;

DROP VIEW IF EXISTS android_kswapd_output;
CREATE PERFETTO VIEW android_kswapd_output AS
SELECT AndroidKswapdMetric(
  'cpu_stats', (
    SELECT
      RepeatedField(AndroidKswapdMetric_KswapdCpuStats(
        'cpu', cpu,
        'total_cpu_duration_ns', cpu_dur,
        'kswapd_on_cpu_duration_ns', kswapd_dur,
        'kswapd_on_cpu_percentage', kswapd_pct
      ))
    FROM android_kswapd_cpu_breakdown
  )
);
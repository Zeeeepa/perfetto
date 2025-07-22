--
-- Copyright 2025 The Android Open Source Project
--
-- Licensed under the Apache License, Version 2.0 (the 'License');
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an 'AS IS' BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- Breakdown of kswapd duration on each cpu.
DROP VIEW IF EXISTS android_kswapd_cpu_breakdown;
CREATE PERFETTO VIEW android_kswapd_cpu_breakdown (
  -- cpu
  cpu LONG,
  -- cpu duration
  cpu_dur LONG,
  -- kswapd duration
  kswapd_dur LONG,
  -- percentage of kswapd
  kswapd_pct DOUBLE
) AS
SELECT cpu, SUM(dur) AS cpu_dur, kswapd_dur,
    CASE WHEN SUM(dur) > 0 THEN CAST(kswapd_dur AS DOUBLE) / SUM(dur) * 100.0
    ELSE 0.0
    END AS kswapd_pct
FROM sched
JOIN (
    SELECT cpu, SUM(dur) AS kswapd_dur
    FROM sched JOIN thread USING (utid)
    WHERE thread.name = 'kswapd0'
    GROUP BY cpu
    ) kd
USING (cpu)
GROUP BY cpu;
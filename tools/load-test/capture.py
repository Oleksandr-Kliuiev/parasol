#!/usr/bin/env python3
"""Record only the owned local DEV-16 hosts and SQL container, plus cached query plans."""
import argparse
import gzip
import json
from pathlib import Path
import platform
import subprocess
import time
from local import ownership, sql


def output(args):
    return subprocess.check_output(args, text=True).strip()


def snapshot(state, path):
    # These are executed-plan cache counters plus estimated cached plans, not actual operator row counts.
    # Start/end snapshots permit deltas; no system-wide cache reset, DBCC or shared-server mutation.
    query = """
SELECT TOP(20) (SELECT CONVERT(varchar(130),s.plan_handle,1) planHandle,
    s.statement_start_offset statementStartOffset,s.statement_end_offset statementEndOffset,
    CONVERT(varchar(18),s.query_hash,1) queryHash,
    s.execution_count executions,s.total_worker_time cpuMicroseconds,s.total_elapsed_time elapsedMicroseconds,
    s.total_logical_reads logicalReads,s.total_physical_reads physicalReads,s.total_rows returnedRows,
    LEFT(SUBSTRING(t.text,s.statement_start_offset/2+1,
        (CASE WHEN s.statement_end_offset=-1 THEN DATALENGTH(t.text) ELSE s.statement_end_offset END-s.statement_start_offset)/2+1),1200) queryText
    FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
FROM sys.dm_exec_query_stats s CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t
CROSS APPLY sys.dm_exec_plan_attributes(s.plan_handle) a
WHERE a.attribute='dbid' AND CONVERT(int,a.value)=DB_ID()
 AND t.text NOT LIKE '%sys.dm_exec_query_stats%' AND t.text NOT LIKE '%HASHBYTES%'
 AND t.text NOT LIKE '%Synthetic DEV16%' AND t.text NOT LIKE '%sp_updatestats%'
ORDER BY s.total_logical_reads DESC;
"""
    entries = [json.loads(line) for line in sql(state, query).splitlines() if line.strip()]
    path.write_text(json.dumps(entries, indent=2)+'\n')
    unique_plans = list({entry['planHandle']: entry for entry in entries}.values())
    for index, entry in enumerate(unique_plans[:5]):
        compressed = sql(state, f"DECLARE @v varchar(max)=(SELECT CONVERT(varchar(max),COMPRESS(CONVERT(nvarchar(max),query_plan)),2) FROM sys.dm_exec_query_plan({entry['planHandle']})), @i int=1; WHILE @i<=LEN(@v) BEGIN SELECT SUBSTRING(@v,@i,8000); SET @i+=8000; END;")
        if compressed and compressed != 'NULL':
            plan = gzip.decompress(bytes.fromhex(''.join(compressed.split()))).decode('utf-16-le')
            path.with_name(path.stem+f'-plan-{index+1}.sqlplan').write_text(plan)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=180)
    args = parser.parse_args()
    state = json.loads((args.directory/'state.private.json').read_text())
    ownership(state)
    args.output.mkdir(parents=True, exist_ok=True)
    needles = [f"Crm.Web.dll --urls https://localhost:{state['webPort']}", f"Crm.Worker.dll --urls http://localhost:{state['workerPort']}"]
    rows = output(['ps','-axo','pid=,command=']).splitlines()
    pids = [row.split()[0] for row in rows if any(needle in row for needle in needles)]
    if len(pids) != 2:
        raise ValueError('Expected exactly the owned Web and Worker process; start local.py serve first')
    environment = dict(capturedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()), platform=platform.platform(),
        cpu=output(['sysctl','-n','machdep.cpu.brand_string']), logicalCpus=int(output(['sysctl','-n','hw.logicalcpu'])),
        memoryBytes=int(output(['sysctl','-n','hw.memsize'])),
        sql=sql(state,'SELECT @@VERSION;'), sqlMemoryLimitMb=2048,
        containerImage=output(['docker','inspect','--format','{{.Image}}',state['container']]),
        note='Shared local laptop; SQL Server Linux amd64 under Docker emulation. Other workloads are not stopped. Not an agreed EXT-05 environment.')
    (args.output/'environment.json').write_text(json.dumps(environment,indent=2)+'\n')
    snapshot(state,args.output/'sql-start.json')
    end = time.monotonic()+args.seconds
    with open(args.output/'resources.jsonl','w') as f:
        while time.monotonic()<end:
            sample = dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
                hosts=output(['ps','-p',','.join(pids),'-o','pid=,pcpu=,rss=']).splitlines(),
                sql=json.loads(output(['docker','stats','--no-stream','--format','{{json .}}',state['container']])))
            f.write(json.dumps(sample)+'\n'); f.flush()
            time.sleep(3)
    snapshot(state,args.output/'sql-end.json')
    print('Resource samples and executed-query counters/cached estimated plans saved to '+str(args.output))


if __name__=='__main__':
    main()

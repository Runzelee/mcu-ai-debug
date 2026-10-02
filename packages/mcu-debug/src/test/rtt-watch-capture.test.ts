import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RttWatchStore } from "../common/rtt-watch";
import { RttWatchRecording } from "../common/rtt-watch-capture";
const source = { sessionId: "session-a", sessionName: "STM32", channel: 0, label: "[data]" };

test("RTT JSONL recording preserves scalar types, every frame and null for removed selected fields", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtt-record-"));
    try {
        const store = new RttWatchStore();
        const initial = store.feed(source, Buffer.from('v={"n":1,"b":false,"s":"hello","nil":null}\n'))[0];
        const file = path.join(dir, 'record.jsonl'), errors: Error[] = [];
        const recording = await RttWatchRecording.create(file, 'jsonl', store.leaves, e => errors.push(e));
        recording.record(initial);
        for (let i=0;i<100;i++) recording.record(store.feed(source, Buffer.from(`v={"n":${i}}\n`), 1000+i)[0]);
        recording.record(store.feed({...source, channel:1}, Buffer.from('v={"n":777}\n'))[0]);
        await recording.stop();
        const rows = fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
        assert.equal(rows.length, 101);
        assert.equal(rows[100].timestamp, 1099);
        assert.deepEqual(Object.values(rows[0].values), [1,false,'hello',null]);
        assert.deepEqual(Object.values(rows[100].values), [99,null,null,null]);
        assert.equal(rows[0].source.channel, 0);
        assert.deepEqual(errors, []);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test("RTT CSV capture escapes quotes/newlines and isolates asynchronous records in fixed columns", async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rtt-csv-'));
    try {
        const store=new RttWatchStore();
        const first=store.feed(source,Buffer.from('a={"s":"comma,quote\\\" and newline\\n","n":0}\n'))[0];
        store.feed(source,Buffer.from('b={"z":true}\n'));
        const file=path.join(dir,'record.csv');
        const recording=await RttWatchRecording.create(file,'csv',store.leaves,()=>{});
        recording.record(first);
        recording.record(store.feed(source,Buffer.from('b={"z":false}\n'))[0]);
        await recording.stop();
        const text=fs.readFileSync(file,'utf8');
        assert(text.includes('"comma,quote"" and newline\n"'));
        assert(text.endsWith('"b","","","false"\n'));
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test("RTT capture reports file-open failure instead of starting a recording", async () => {
    const errors:Error[]=[];
    await assert.rejects(RttWatchRecording.create('/no-such-directory/rtt/file.jsonl','jsonl',[],e=>errors.push(e)));
    assert.equal(errors.length,1);
});

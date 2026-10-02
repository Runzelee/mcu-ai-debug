const assert = require('node:assert/strict');
const fs = require('node:fs');
exports.run = async ({vscode,base,port}) => {
    assert.equal(vscode.debug.activeDebugSession, undefined);
    await vscode.commands.executeCommand('workbench.view.extension.mcu-ai-debug');
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.includes('workbench'));
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject) => {socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let seq=0; const pending=new Map();
    socket.addEventListener('message',({data}) => {const m=JSON.parse(data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);});
    const call=(method,params={}) => new Promise((resolve,reject) => {const id=++seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>reject(new Error('CDP timeout '+method)),6000)});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression => {const r=await call('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const delay=ms=>new Promise(r=>setTimeout(r,ms));
    const capture=async name=>{await delay(300);const {data}=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${base}/${name}.png`,Buffer.from(data,'base64'));};
    try {
        let state;const end=Date.now()+15000;
        do {
            state=await evaluate(`({headers:[...(document.getElementById('workbench.parts.sidebar')?.querySelectorAll('.pane-header') ?? [])].map(e=>e.textContent.trim()),pulseIcons:document.querySelectorAll('.activitybar .codicon-pulse').length})`);
            if(state.headers.some(s=>s.includes('GDB Live Watch')) && state.headers.some(s=>s.includes('JSON Live Watch')))break;
            if(Date.now()>end)throw new Error('Both Live Watch views must be present before debugging: '+JSON.stringify(state));
            await delay(80);
        }while(true);
        assert.equal(state.headers.length,2,JSON.stringify(state));
        assert(state.headers[0].includes('GDB Live Watch'),JSON.stringify(state));
        assert(state.headers[1].includes('JSON Live Watch'),JSON.stringify(state));
        assert.equal(state.pulseIcons,1,'Only one Live Watch activity icon');
        await capture('live-watch-sidebar-before-debug');
        fs.writeFileSync(`${base}/live-watch-sidebar-ui.json`,JSON.stringify({beforeDebug:true,gdbAboveRtt:true,oneActivityIcon:true,...state},null,2));
    }catch(error){await capture('live-watch-sidebar-failed');throw error;}finally{socket.close();}
};

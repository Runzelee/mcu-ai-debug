const fs=require('node:fs');
const assert=require('node:assert/strict');
exports.run=async({vscode,api,rttConnection,uartConnection,base,port})=>{
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('mcu-ai-debug.rttLiveWatch.focus');
    const commands=await vscode.commands.getCommands(true);
    if(commands.includes('workbench.action.increaseViewWidth'))for(let i=0;i<3;i++)await vscode.commands.executeCommand('workbench.action.increaseViewWidth');
    if(commands.includes('notifications.clearAll'))await vscode.commands.executeCommand('notifications.clearAll');
    // Select one numeric series from each transport in the actual graph picker.
    rttConnection.write('buzzer_debug={"frequency_hz":4030,"nested":{"gain":3}}\n');
    uartConnection.write('buzzer_debug={"frequency_hz":9630}\n');
    const readyEnd=Date.now()+5000;
    while(api.rttWatchProvider.store.leaves.filter(n=>n.path[0]==="frequency_hz").length!==2){
        if(Date.now()>readyEnd)throw new Error("Mixed graph telemetry timeout");
        await new Promise(resolve=>setTimeout(resolve,20));
    }
    const graphPick=vscode.window.showQuickPick;
    vscode.window.showQuickPick=async items=>items.filter(item=>item.key?.endsWith("/frequency_hz"));
    try{await api.rttWatchProvider.openGraph();}finally{vscode.window.showQuickPick=graphPick;}
    api.rttWatchProvider.grapher.panel?.reveal(vscode.ViewColumn.One);
    const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page'&&t.url.includes('workbench'));
    const socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
    let seq=0;const pending=new Map();
    socket.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);});
    const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},6000)});socket.send(JSON.stringify({id,method,params,sessionId}));});
    const delay=ms=>new Promise(r=>setTimeout(r,ms));
    const evaluate=async(expression,sessionId)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const until=async(fn)=>{const end=Date.now()+15000;while(!await fn()){if(Date.now()>end)throw new Error('RTT visual timed out');await delay(80);}};
    const sessions=new Map();
    const find=selector=>`(()=>{function f(d){if(d.querySelector(${JSON.stringify(selector)}))return d;for(const x of d.querySelectorAll('iframe')){try{if(x.contentDocument){const c=f(x.contentDocument);if(c)return c;}}catch{}}return null;}return f(document);})()`;
    const getSession=async selector=>{let found;await until(async()=>{const {targetInfos}=await call('Target.getTargets');for(const t of targetInfos.filter(t=>t.type==='iframe')){let id=sessions.get(t.targetId);if(!id){id=(await call('Target.attachToTarget',{targetId:t.targetId,flatten:true})).sessionId;sessions.set(t.targetId,id);}if(await evaluate(`!!${find(selector)}`,id)){found=id;return true;}}return false;});return found;};
    const capture=async name=>{await delay(300);const {data}=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${base}/${name}.png`,Buffer.from(data,'base64'));};
    try{
        await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
        const sidebar=await evaluate('(()=>{const r=document.getElementById("workbench.parts.sidebar").getBoundingClientRect();return {right:r.right,top:r.top,height:r.height};})()');
        const sashY=Math.round(sidebar.top+sidebar.height/2),sashX=Math.round(sidebar.right);
        await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:sashX,y:sashY});
        await call("Input.dispatchMouseEvent",{type:"mousePressed",x:sashX,y:sashY,button:"left",buttons:1,clickCount:1});
        await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:420,y:sashY,button:"left",buttons:1});
        await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:420,y:sashY,button:"left",buttons:0,clickCount:1});
        const tree=await getSession('body[data-readonly="true"]');const td=find('body[data-readonly="true"]');
        await until(()=>evaluate(`${td}.body.textContent.includes('frequency_hz')`,tree));
        assert.equal(await evaluate(`${td}.querySelector('#watch-onboarding')`,tree),null);
        assert.equal(await evaluate(`!!${td}.querySelector('#copy-firmware-prompt')`,tree),false);
        api.rttWatchProvider.clear();
        await until(()=>evaluate(`!!${td}.querySelector('#copy-firmware-prompt')`,tree));
        await capture('rtt-onboarding-empty');
        await vscode.env.clipboard.writeText('');
        await evaluate(`${td}.querySelector('#copy-firmware-prompt').click()`,tree);
        await until(async()=> (await vscode.env.clipboard.readText()).includes('SEGGER_RTT_Write(channel, buffer, length)'));
        if(commands.includes('notifications.clearAll'))await vscode.commands.executeCommand('notifications.clearAll');
        rttConnection.write('buzzer_debug='+JSON.stringify({frequency_hz:4030,nested:{gain:3},text:'<img src=x onerror="bad()">'})+'\n');
        await until(()=>evaluate(`!${td}.querySelector('#copy-firmware-prompt') && ${td}.body.textContent.includes('frequency_hz')`,tree));
        assert.equal(await evaluate(`${td}.querySelectorAll('img').length`,tree),0,'RTT values must be rendered as text');
        assert(await evaluate(`${td}.body.textContent.includes('<img src=x')`,tree));
        const graph=await getSession('#graph-canvas'),gd=find('#graph-canvas');
        const run=expression=>evaluate(`(()=>{const d=${gd};${expression}})()`,graph);
        assert.equal(await run('return d.querySelectorAll(".legend-name").length;'),2);
        assert(await run('return [...d.querySelectorAll(".legend-name")].every(x=>x.textContent && x.textContent!=="undefined");'));
        assert(await run('return [...d.querySelectorAll(".legend-name")].some(x=>x.textContent.includes("UART"));'));
        assert(await run('return [...d.querySelectorAll(".legend-name")].some(x=>x.textContent.includes("RTT"));'));
        await run('d.querySelector("#btn-clear").click();d.querySelector("#timespan").value="4";d.querySelector("#timespan").dispatchEvent(new Event("change",{bubbles:true}));');
        for(let i=0;i<80;i++){rttConnection.write('buzzer_debug='+JSON.stringify({frequency_hz:4000+Math.sin(i/7)*200,nested:{gain:Math.cos(i/9)*30},text:'Streaming'})+'\n');uartConnection.write('buzzer_debug='+JSON.stringify({frequency_hz:9600+Math.cos(i/9)*200})+'\n');await delay(50);}
        await until(()=>run('return d.querySelector("#empty-state").hidden;'));
        await capture('rtt-watch-graph-dark');
        await run('d.querySelector("#btn-pause").click();');
        assert.equal(await run('return d.querySelector("#btn-pause").getAttribute("aria-pressed");'),'true');
        assert.equal(await run('return d.querySelector("#btn-pause use").getAttribute("href");'),'#icon-play');
        await run('d.querySelector("#btn-pause").click();d.querySelector("#btn-autofit").click();');
        assert.equal(await run('return d.querySelector("#btn-autofit .button-label").textContent;'),'Pan');
        await run('d.querySelector("#btn-autofit").click();d.querySelector("#mode").value="split";d.querySelector("#mode").dispatchEvent(new Event("change",{bubbles:true}));');
        await capture('json-live-watch-graph-modern');
        await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Light Modern',vscode.ConfigurationTarget.Global);
        await capture('rtt-watch-graph-light-split');
        await call('Emulation.setDeviceMetricsOverride',{width:850,height:900,deviceScaleFactor:1,mobile:false});
        await capture('rtt-watch-graph-light-narrow');
        const metrics=await run('return {width:d.body.clientWidth,scroll:d.body.scrollWidth,overflow:[...d.querySelectorAll("*")].map(e=>({tag:e.tagName,id:e.id,cls:e.className?.baseVal??e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:e.clientWidth,scroll:e.scrollWidth})).filter(e=>e.right>d.body.clientWidth+1)};');
        fs.writeFileSync(`${base}/rtt-layout-metrics.json`,JSON.stringify(metrics,null,2));
        assert(metrics.scroll<=metrics.width+1 && metrics.overflow.length===0,'Graph must fit narrow editor (1 px fractional layout tolerance)');
        await run('d.querySelector("#btn-clear").click();');
        assert.equal(await run('return d.querySelector("#empty-state").hidden;'),false);
        fs.writeFileSync(`${base}/rtt-real-ui.json`,JSON.stringify({copyEnglishPrompt:true,inlineEmptyPromptOnly:true,readonlyTree:true,noHtmlInjection:true,svgToolbar:true,pauseResume:true,autoPan:true,clear:true,darkLightNarrow:true,hardware:false}));
    }catch(e){await capture('rtt-ui-failed');throw e;}finally{await call('Emulation.clearDeviceMetricsOverride');await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Dark Modern',vscode.ConfigurationTarget.Global);socket.close();}
};

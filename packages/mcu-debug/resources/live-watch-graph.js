// Live Watch Graph - Canvas 2D real-time scrolling time-series renderer
// Zero external dependencies, communicates via VS Code Webview postMessage

(function () {
    const vscode = acquireVsCodeApi();

    // --- DOM refs ---
    const canvas = document.getElementById("graph-canvas");
    const ctx = canvas.getContext("2d");
    const tooltipEl = document.getElementById("tooltip");
    const legendEl = document.getElementById("legend");
    const btnPause = document.getElementById("btn-pause");
    const btnClear = document.getElementById("btn-clear");
    const btnAutofit = document.getElementById("btn-autofit");
    const timespanInput = document.getElementById("timespan");
    const modeSelect = document.getElementById("mode");
    const sliderY = document.getElementById("slider-y");
    const sliderT = document.getElementById("slider-t");

    // --- State ---
    let channels = [];
    let paused = false;
    let timespanSec = 10;
    let displayMode = "overlay";
    let startTime = 0;
    let mouseX = -1;
    let mouseY = -1;

    // Pan/zoom state
    let panMode = false;       // false = auto-scroll (oscilloscope), true = frozen/pan
    let isDragging = false;
    let panOffsetT = 0;        // time pan (seconds)
    let panOffsetY = 0;        // Y pan (pixels)
    let zoomT = 1.0;           // time zoom (applied to timespanSec)
    let zoomY = 1.0;           // Y zoom

    // --- Palette ---
    const PALETTE = [
        "#4fc3f7", "#81c784", "#ffb74d", "#e57373",
        "#ba68c8", "#4dd0e1", "#fff176", "#f06292",
        "#aed581", "#64b5f6", "#ff8a65", "#a1887f",
        "#90a4ae", "#dce775", "#7986cb", "#4db6ac",
    ];

    // --- Toolbar events ---
    btnPause.addEventListener("click", () => {
        paused = !paused;
        btnPause.textContent = paused ? "\u25b6 Resume" : "\u23f8 Pause";
        btnPause.classList.toggle("active", paused);
    });

    btnClear.addEventListener("click", () => {
        for (const ch of channels) { ch.data = []; }
        startTime = 0;
        resetView();
    });

    btnAutofit.addEventListener("click", () => {
        if (panMode) {
            // Switch back to auto-scroll
            panMode = false;
            resetView();
            btnAutofit.textContent = "\ud83d\udd12 Auto";
            btnAutofit.classList.remove("active");
            canvas.style.cursor = "crosshair";
        }
    });

    timespanInput.addEventListener("change", () => {
        timespanSec = Math.max(1, Math.min(300, parseInt(timespanInput.value) || 10));
        timespanInput.value = timespanSec;
    });

    modeSelect.addEventListener("change", () => {
        displayMode = modeSelect.value;
    });

    function resetView() {
        panMode = false;
        panOffsetT = 0;
        panOffsetY = 0;
        zoomT = 1.0;
        zoomY = 1.0;
        sliderY.value = 100;
        sliderT.value = 100;
    }

    function enterPanMode() {
        if (!panMode) {
            panMode = true;
            btnAutofit.textContent = "\ud83d\udd13 Auto";
            btnAutofit.classList.add("active");
            canvas.style.cursor = "grab";
        }
    }

    // --- Canvas sizing ---
    function resizeCanvas() {
        const container = canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = container.clientWidth * dpr;
        canvas.height = container.clientHeight * dpr;
        ctx.scale(dpr, dpr);
    }
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();

    // --- Mouse interaction ---
    canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        const prevX = mouseX;
        const prevY = mouseY;
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;

        if (isDragging && panMode && prevX !== -1) {
            const dx = mouseX - prevX;
            const dy = mouseY - prevY;
            const plotW = canvas.parentElement.clientWidth - MARGIN.left - MARGIN.right;
            const plotH = canvas.parentElement.clientHeight - MARGIN.top - MARGIN.bottom;
            const effectiveSpan = timespanSec / zoomT;
            if (plotW > 0) {
                panOffsetT += (dx / plotW) * effectiveSpan;
            }
            if (plotH > 0) {
                panOffsetY += dy;
            }
        }
    });

    canvas.addEventListener("mousedown", () => {
        if (panMode) {
            isDragging = true;
            canvas.style.cursor = "grabbing";
        }
    });

    window.addEventListener("mouseup", () => {
        if (isDragging) {
            isDragging = false;
            if (panMode) canvas.style.cursor = "grab";
        }
    });

    canvas.addEventListener("mouseleave", () => {
        if (!isDragging) {
            mouseX = -1;
            mouseY = -1;
            tooltipEl.style.display = "none";
        }
    });

    // Double-click = reset view to auto-scroll
    canvas.addEventListener("dblclick", () => {
        resetView();
        btnAutofit.textContent = "\ud83d\udd12 Auto";
        btnAutofit.classList.remove("active");
        canvas.style.cursor = "crosshair";
    });

    // Mouse wheel: enters pan mode automatically
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        enterPanMode();

        if (e.ctrlKey) {
            // Y axis zoom
            const factor = e.deltaY > 0 ? 0.8 : 1.25;
            zoomY = Math.max(0.01, Math.min(100, zoomY * factor));
            sliderY.value = 100 + Math.log10(zoomY) / 2 * 100;
        } else {
            // Time axis zoom
            const factor = e.deltaY > 0 ? 0.8 : 1.25;
            zoomT = Math.max(0.01, Math.min(100, zoomT * factor));
            sliderT.value = 100 + Math.log10(zoomT) / 2 * 100;
        }
    }, { passive: false });

    // Right-click drag also enters pan mode
    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        enterPanMode();
    });

    // Any mousedown in non-pan area with middle button enters pan
    canvas.addEventListener("mousedown", (e) => {
        if (e.button === 1) { // middle click
            e.preventDefault();
            enterPanMode();
            isDragging = true;
            canvas.style.cursor = "grabbing";
        }
    });

    // Left click drag also enters pan mode
    canvas.addEventListener("mousedown", (e) => {
        if (e.button === 0) {
            const x0 = MARGIN.left;
            const plotW = canvas.parentElement.clientWidth - MARGIN.left - MARGIN.right;
            // Only enter pan mode if clicking inside the plot area
            if (mouseX >= x0 && mouseX <= x0 + plotW) {
                enterPanMode();
                isDragging = true;
                canvas.style.cursor = "grabbing";
            }
        }
    });

    // --- Slider controls ---
    sliderY.addEventListener("input", () => {
        enterPanMode();
        // slider 100 = zoom 1.0; 200 = zoom 10x; 1 = zoom 0.1x (logarithmic)
        zoomY = Math.pow(10, (sliderY.value - 100) / 100 * 2);
    });

    sliderT.addEventListener("input", () => {
        enterPanMode();
        zoomT = Math.pow(10, (sliderT.value - 100) / 100 * 2);
    });

    // --- Configure channels ---
    function configure(keys) {
        channels = keys.map((key, i) => ({
            key, color: PALETTE[i % PALETTE.length], visible: true, data: [], plotInfo: null,
        }));
        startTime = 0;
        resetView();
        buildLegend();
    }

    // --- Build legend ---
    function buildLegend() {
        legendEl.innerHTML = "";
        for (const ch of channels) {
            const item = document.createElement("div");
            item.className = "legend-item" + (ch.visible ? "" : " hidden");
            item.innerHTML =
                `<span class="legend-color" style="background:${ch.color}"></span>` +
                `<span class="legend-name">${ch.key}</span>` +
                `<span class="legend-value" id="lv-${ch.key}"></span>`;
            item.addEventListener("click", () => {
                ch.visible = !ch.visible;
                item.classList.toggle("hidden", !ch.visible);
            });
            legendEl.appendChild(item);
        }
    }

    // --- Receive data ---
    function pushData(timestamp, dataMap) {
        if (startTime === 0) startTime = timestamp;
        const t = (timestamp - startTime) / 1000;
        for (const ch of channels) {
            const rawVal = dataMap[ch.key];
            if (rawVal !== undefined) {
                const v = parseFloat(rawVal);
                if (!isNaN(v)) ch.data.push({ t, v });
            }
        }
        // Trim old data
        const cutoff = t - timespanSec * 3;
        for (const ch of channels) {
            while (ch.data.length > 0 && ch.data[0].t < cutoff) ch.data.shift();
        }
    }

    // --- Drawing constants ---
    // --- Drawing constants ---
    const MARGIN = { top: 40, right: 60, bottom: 30, left: 65 };
    const GRID_COLOR = "rgba(255,255,255,0.07)";
    const AXIS_COLOR = "rgba(255,255,255,0.3)";
    const CURSOR_COLOR = "rgba(255,255,255,0.15)";

    function fmtVal(v) {
        if (Math.abs(v) >= 1e6 || (Math.abs(v) < 0.001 && v !== 0)) return v.toExponential(2);
        return parseFloat(v.toFixed(4)).toString();
    }

    function fmtTime(sec) {
        if (sec < 0) return "-" + fmtTime(-sec);
        if (sec < 60) return sec.toFixed(1) + "s";
        const m = Math.floor(sec / 60);
        const s = (sec % 60).toFixed(0);
        return m + "m" + s.padStart(2, "0") + "s";
    }

    // --- Compute time range ---
    function getTimeRange(visibleChannels) {
        let now = 0;
        for (const ch of visibleChannels) {
            if (ch.data.length > 0) now = Math.max(now, ch.data[ch.data.length - 1].t);
        }
        const effectiveSpan = timespanSec / zoomT;
        let tMax, tMin;
        if (panMode) {
            tMax = now - panOffsetT;
            tMin = tMax - effectiveSpan;
        } else {
            // Auto-scroll: always show latest data
            tMax = now;
            tMin = now - effectiveSpan;
        }
        return { tMin, tMax };
    }

    // --- Compute Y range for data in time window, with zoom/pan ---
    function getYRange(dataArrays, tMin, tMax, plotH) {
        let yMin = Infinity, yMax = -Infinity;
        for (const data of dataArrays) {
            for (const pt of data) {
                if (pt.t >= tMin && pt.t <= tMax) {
                    if (pt.v < yMin) yMin = pt.v;
                    if (pt.v > yMax) yMax = pt.v;
                }
            }
        }
        if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
        const pad = (yMax - yMin) * 0.08 || 1;
        yMin -= pad;
        yMax += pad;

        if (panMode) {
            // Apply Y zoom around center
            const center = (yMax + yMin) / 2;
            const halfSpan = ((yMax - yMin) / 2) / zoomY;
            // Apply Y pan (convert pixel offset to value offset)
            const valPerPx = (yMax - yMin) / (plotH || 1);
            const panVal = panOffsetY * valPerPx / zoomY;
            yMin = center + panVal - halfSpan;
            yMax = center + panVal + halfSpan;
        }

        return { yMin, yMax };
    }

    // --- Main render loop ---
    function render() {
        const w = canvas.parentElement.clientWidth;
        const h = canvas.parentElement.clientHeight;
        ctx.clearRect(0, 0, w, h);

        const visibleChannels = channels.filter(ch => ch.visible);

        if (visibleChannels.length === 0) {
            ctx.fillStyle = AXIS_COLOR;
            ctx.font = "14px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("Waiting for data...", w / 2, h / 2);
            requestAnimationFrame(render);
            return;
        }

        if (displayMode === "split") {
            renderSplit(w, h, visibleChannels);
        } else {
            renderOverlay(w, h, visibleChannels);
        }

        // Pan mode indicator (draw above the plot area)
        if (panMode) {
            ctx.fillStyle = "rgba(255,200,50,0.7)";
            ctx.font = "10px sans-serif";
            ctx.textAlign = "right";
            ctx.fillText("PAN MODE (double-click to reset)", w - 10, 15);
        }

        requestAnimationFrame(render);
    }

    // --- Overlay mode ---
    function renderOverlay(w, h, visibleChannels) {
        const plotW = w - MARGIN.left - MARGIN.right;
        const plotH = h - MARGIN.top - MARGIN.bottom;
        const { tMin, tMax } = getTimeRange(visibleChannels);
        const allData = visibleChannels.map(ch => ch.data);
        const { yMin, yMax } = getYRange(allData, tMin, tMax, plotH);

        for (const ch of visibleChannels) {
            ch.plotInfo = { yMin, yMax, plotH, ofsY: MARGIN.top };
        }

        drawGrid(MARGIN.left, MARGIN.top, plotW, plotH, tMin, tMax, yMin, yMax, true);

        // Clip curves to plot area
        ctx.save();
        ctx.beginPath();
        ctx.rect(MARGIN.left, MARGIN.top, plotW, plotH);
        ctx.clip();
        for (const ch of visibleChannels) {
            drawLine(ch, MARGIN.left, MARGIN.top, plotW, plotH, tMin, tMax, yMin, yMax);
        }
        ctx.restore();

        drawCursor(visibleChannels, plotW, tMin, tMax);
        updateLegendValues();
    }

    // --- Split mode ---
    function renderSplit(w, h, visibleChannels) {
        const n = visibleChannels.length;
        const perH = (h - MARGIN.top - 10) / n;
        const { tMin, tMax } = getTimeRange(visibleChannels);
        const plotW = w - MARGIN.left - MARGIN.right;

        for (let i = 0; i < n; i++) {
            const ch = visibleChannels[i];
            const ofsY = MARGIN.top + i * perH;
            const plotH = perH - 25;

            const { yMin, yMax } = getYRange([ch.data], tMin, tMax, plotH);
            ch.plotInfo = { yMin, yMax, plotH, ofsY };

            // Channel label (draw above the panel border with padding)
            ctx.fillStyle = ch.color;
            ctx.font = "11px sans-serif";
            ctx.textBaseline = "bottom"; // Prevent state leakage from drawGrid
            ctx.textAlign = "left";
            ctx.fillText(ch.key, MARGIN.left + 5, ofsY - 4);

            drawGrid(MARGIN.left, ofsY, plotW, plotH, tMin, tMax, yMin, yMax, i === n - 1);

            // Clip curve
            ctx.save();
            ctx.beginPath();
            ctx.rect(MARGIN.left, ofsY, plotW, plotH);
            ctx.clip();
            drawLine(ch, MARGIN.left, ofsY, plotW, plotH, tMin, tMax, yMin, yMax);
            ctx.restore();
        }

        drawCursor(visibleChannels, plotW, tMin, tMax);
        updateLegendValues();
    }

    // --- Draw grid ---
    function drawGrid(x0, y0, plotW, plotH, tMin, tMax, yMin, yMax, drawTimeLabels) {
        ctx.strokeStyle = AXIS_COLOR;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, y0, plotW, plotH);

        // Y axis ticks
        const ySteps = niceSteps(yMin, yMax, 6);
        ctx.fillStyle = AXIS_COLOR;
        ctx.font = "10px monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (const yVal of ySteps) {
            const py = y0 + plotH - ((yVal - yMin) / (yMax - yMin)) * plotH;
            if (py < y0 || py > y0 + plotH) continue;
            ctx.beginPath();
            ctx.strokeStyle = GRID_COLOR;
            ctx.moveTo(x0, py);
            ctx.lineTo(x0 + plotW, py);
            ctx.stroke();
            ctx.fillStyle = AXIS_COLOR;
            ctx.fillText(fmtVal(yVal), x0 - 5, py);
        }

        // Time axis ticks
        if (drawTimeLabels) {
            const tSteps = niceSteps(tMin, tMax, 8);
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            for (const tVal of tSteps) {
                const px = x0 + ((tVal - tMin) / (tMax - tMin)) * plotW;
                if (px < x0 || px > x0 + plotW) continue;
                ctx.beginPath();
                ctx.strokeStyle = GRID_COLOR;
                ctx.moveTo(px, y0);
                ctx.lineTo(px, y0 + plotH);
                ctx.stroke();
                ctx.fillStyle = AXIS_COLOR;
                ctx.fillText(fmtTime(tVal), px, y0 + plotH + 4);
            }
        }
    }

    // --- Draw a single curve ---
    function drawLine(ch, x0, y0, plotW, plotH, tMin, tMax, yMin, yMax) {
        if (ch.data.length < 2) return;

        ctx.beginPath();
        ctx.strokeStyle = ch.color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";

        let started = false;
        for (const pt of ch.data) {
            const px = x0 + ((pt.t - tMin) / (tMax - tMin)) * plotW;
            const py = y0 + plotH - ((pt.v - yMin) / (yMax - yMin)) * plotH;
            if (!started) {
                ctx.moveTo(px, py);
                started = true;
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.stroke();
    }

    // --- Cursor and tooltip ---
    function drawCursor(visibleChannels, plotW, tMin, tMax) {
        const x0 = MARGIN.left;
        const canvasH = canvas.parentElement.clientHeight;

        if (isDragging) { tooltipEl.style.display = "none"; return; }
        if (mouseX < x0 || mouseX > x0 + plotW || mouseY < MARGIN.top || mouseY > canvasH - 5) {
            tooltipEl.style.display = "none";
            return;
        }

        // Vertical cursor line
        ctx.beginPath();
        ctx.strokeStyle = CURSOR_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.moveTo(mouseX, MARGIN.top);
        ctx.lineTo(mouseX, canvasH - 5);
        ctx.stroke();
        ctx.setLineDash([]);

        const tCursor = tMin + ((mouseX - x0) / plotW) * (tMax - tMin);

        let lines = ["t = " + fmtTime(tCursor)];
        for (const ch of visibleChannels) {
            let closest = null;
            let minDist = Infinity;
            for (const pt of ch.data) {
                const dist = Math.abs(pt.t - tCursor);
                if (dist < minDist) { minDist = dist; closest = pt; }
            }
            const effectiveSpan = timespanSec / zoomT;
            if (closest && minDist < effectiveSpan * 0.05) {
                lines.push(`${ch.key}: ${fmtVal(closest.v)}`);

                if (ch.plotInfo) {
                    const info = ch.plotInfo;
                    const px = x0 + ((closest.t - tMin) / (tMax - tMin)) * plotW;
                    const py = info.ofsY + info.plotH - ((closest.v - info.yMin) / (info.yMax - info.yMin)) * info.plotH;
                    if (py >= info.ofsY && py <= info.ofsY + info.plotH) {
                        ctx.beginPath();
                        ctx.fillStyle = ch.color;
                        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
        }

        tooltipEl.textContent = lines.join("\n");
        tooltipEl.style.display = "block";

        const container = canvas.parentElement;
        let tx = mouseX + 12;
        let ty = mouseY - 10;
        if (tx + 200 > container.clientWidth) tx = mouseX - 200;
        if (ty + 150 > container.clientHeight) ty = mouseY - 150;
        if (ty < 0) ty = 5;
        tooltipEl.style.left = tx + "px";
        tooltipEl.style.top = ty + "px";
    }

    // --- Update legend values ---
    function updateLegendValues() {
        for (const ch of channels) {
            const el = document.getElementById("lv-" + ch.key);
            if (el && ch.data.length > 0) {
                el.textContent = " = " + fmtVal(ch.data[ch.data.length - 1].v);
            }
        }
    }

    // --- Nice tick steps ---
    function niceSteps(min, max, targetCount) {
        const range = max - min;
        if (range <= 0) return [min];
        const rough = range / targetCount;
        const pow = Math.pow(10, Math.floor(Math.log10(rough)));
        let step;
        const norm = rough / pow;
        if (norm < 1.5) step = pow;
        else if (norm < 3) step = 2 * pow;
        else if (norm < 7) step = 5 * pow;
        else step = 10 * pow;
        const steps = [];
        let v = Math.ceil(min / step) * step;
        while (v <= max) { steps.push(v); v += step; }
        return steps;
    }

    // --- Message listener ---
    window.addEventListener("message", (event) => {
        const msg = event.data;
        switch (msg.type) {
            case "configure": configure(msg.keys); break;
            case "data":
                if (!paused) pushData(msg.timestamp, msg.values);
                break;
        }
    });

    requestAnimationFrame(render);
    vscode.postMessage({ type: "ready" });
})();

const vscode = acquireVsCodeApi();
function copyFirmwarePrompt(event) {
    event.stopPropagation();
    vscode.postMessage({ type: "copyFirmwarePrompt" });
}
const itemMap = new Map();
const selectedIds = new Set();
const selectedPendingExpressions = new Set();
let pendingExpressions = new Set();
let batchMode = false;
const readOnlyTree = document.body.dataset.readonly === "true";
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
        case "setChildren":
            renderChildren(message.element, message.children);
            break;
        case "newItem":
            startAdd();
            break;
        case "updateItems":
            updateItems(message.items);
            break;
        case "refresh":
            requestChildren();
            break;
        case "setBatchMode":
            setBatchMode(message.enabled);
            break;
        case "batchResult":
            if (message.operation === "add" && message.result.changed > 0) {
                document.getElementById("batch-input").value = "";
                renderPendingExpressions();
            }
            if (message.operation === "delete") {
                selectedIds.clear();
                updateBatchDeleteButton();
            }
            showBatchStatus(message.result.message);
            requestChildren();
            break;
        case "batchCancelled":
            showBatchStatus("Removal cancelled.");
            break;
    }
});

function requestChildren(element) {
    vscode.postMessage({ type: "getChildren", element });
}

function getItemHtml(item) {
    let actionsHtml = "";
    let editValue = `<span class="codicon codicon-edit-sparkle" onclick="startEdit(this, '${item.id}', 'value')" title="Edit Value"></span>`;
    if (item.hasChildren) {
        editValue = "";
    }
    let hexFormat = `<span class="codicon codicon-variable-group" onclick="selectFormat(event, '${item.id}')" title="Select Format"></span>`;

    if (item.id !== "dummy-msg") {
        if (!item.hasChildren) {
            // Leaf node, maybe inside children or top level
            actionsHtml = `
                <div class="actions">
                    ${editValue}
                    ${hexFormat}
                </div>
            `;
        }
    }

    return "";
}

function generateItemContentHtml(item, isTopLevel) {
    if (item.id === "dummy-msg") {
        const copyHint = document.body.dataset.copyFirmwarePrompt === "true"
            ? ` <button id="copy-firmware-prompt" class="firmware-prompt-link" type="button" onclick="copyFirmwarePrompt(event)">Click to copy firmware prompt.</button>` : "";
        return `<span class="dummy-msg">${escapeHtml(item.label)}${copyHint}</span>`;
    }
    let actionsHtml = "";
    let editValueButton = `<span class="codicon codicon-edit-sparkle" onclick="editValue(event, '${item.id}')" title="Edit Value"></span>\n`;
    let editValueText = `<span class="value ${item.changed ? "changed" : ""}" ondblclick="startEdit(this, '${item.id}', 'value')">${escapeHtml(item.value || "")}</span>\n`;
    let editLabelText = `<span class="label" ondblclick="startEdit(this, '${item.id}', 'label')">${escapeHtml(item.label)}</span>\n`;
    if (item.hasChildren || item.readonly) {
        editValueButton = "";
        if (item.readonly) {
            editValueText = `<span class="value readonly ${item.changed ? "changed" : ""}">${escapeHtml(item.value || "")}</span>\n`;
        } else {
            editValueText = `<span class="value ${item.changed ? "changed" : ""}">${escapeHtml(item.value || "")}</span>\n`;
        }
    }
    let hexFormat = `<span class="codicon codicon-variable-group" onclick="selectFormat(event, '${item.id}')" title="Select Format"></span>\n`;

    if (isTopLevel) {
        actionsHtml = `
            <div class="actions">
                <span class="codicon codicon-edit" onclick="editLabel(event, '${item.id}')" title="Edit Expression"></span>
                ${editValueButton}
                ${hexFormat}
                <span class="codicon codicon-arrow-up" onclick="moveUp(event, '${item.id}')" title="Move Up"></span>
                <span class="codicon codicon-arrow-down" onclick="moveDown(event, '${item.id}')" title="Move Down"></span>
                <span class="codicon codicon-close" onclick="deleteItem(event, '${item.id}')" title="Delete"></span>
            </div>
        `;
    } else if (!item.hasChildren) {
        editLabelText = `<span class="label">${escapeHtml(item.label)}</span>\n`;
        actionsHtml = `
            <div class="actions">
                ${editValueButton}
                ${hexFormat}
            </div>
        `;
    }
    if (!isTopLevel) {
        editLabelText = `<span class="label">${escapeHtml(item.label)}</span>\n`;
        actionsHtml = `
            <div class="actions">
                ${editValueButton}
                ${hexFormat}
            </div>
        `;
    }

    if (readOnlyTree) {
        editLabelText = `<span class="label">${escapeHtml(item.label)}</span>
`;
        editValueText = `<span class="value readonly ${item.changed ? "changed" : ""}">${escapeHtml(item.value || "")}</span>
`;
        actionsHtml = "";
    }
    const chevronClass = item.expanded ? "codicon-chevron-down" : "codicon-chevron-right";
    const checkboxHtml =
        batchMode && isTopLevel && item.id !== "dummy-msg"
            ? `<input class="batch-checkbox" type="checkbox" ${selectedIds.has(item.id) ? "checked" : ""} onclick="toggleBatchSelection(event, '${item.id}')" aria-label="Select expression">`
            : "";
    const labelEscaped = escapeHtml(item.contextValue);
    const valueEscaped = escapeHtml(item.value);
    const editLabelWithTitle = editLabelText.replace(/(<span class="label"[^>]*>)/, `$1<span title="${labelEscaped}">`);
    const editValueWithTitle = editValueText.replace(/(<span class="value[^"]*"[^>]*>)/, `$1<span title="${valueEscaped}">`);
    return `
        ${checkboxHtml}
        <span class="codicon ${chevronClass} ${item.hasChildren ? "" : "hidden"}" onclick="toggleExpand(event, '${item.id}')"></span>
        ${editLabelWithTitle}</span>
        ${editValueWithTitle}</span>
        ${actionsHtml}
    `;
}

function updateItems(items) {
    items.forEach((newItem) => {
        const existingItem = itemMap.get(newItem.id);
        if (existingItem) {
            // Update local state
            Object.assign(existingItem, newItem);

            const li = document.querySelector(`li[data-id="${newItem.id}"]`);
            if (li) {
                const contentDiv = li.querySelector(".tree-content");
                if (contentDiv) {
                    const isTopLevel = li.parentElement && li.parentElement.parentElement && li.parentElement.parentElement.id === "tree-root";
                    const newHtml = generateItemContentHtml(existingItem, isTopLevel);
                    if (contentDiv.innerHTML !== newHtml) {
                        contentDiv.innerHTML = newHtml;
                    }
                }
            }
        }
    });
}

function renderChildren(parent, children) {
    const container = parent ? document.getElementById("children-" + parent.id) : document.getElementById("tree-root");
    if (!container) return;

    let ul = container.querySelector("ul");
    if (!ul) {
        ul = document.createElement("ul");
        container.appendChild(ul);
    }

    const existingLiMap = new Map();
    Array.from(ul.children).forEach((li) => {
        if (li.dataset.id) existingLiMap.set(li.dataset.id, li);
    });

    const keepIds = new Set();

    children.forEach((item) => {
        itemMap.set(item.id, item);
        keepIds.add(item.id);

        let li = existingLiMap.get(item.id);
        let contentDiv;

        if (!li) {
            li = document.createElement("li");
            li.className = "tree-item";
            li.dataset.id = item.id;

            contentDiv = document.createElement("div");
            contentDiv.className = "tree-content";
            li.appendChild(contentDiv);
        } else {
            contentDiv = li.querySelector(".tree-content");
        }

        const isTopLevel = !parent;
        const newHtml = generateItemContentHtml(item, isTopLevel);

        if (contentDiv.innerHTML !== newHtml) {
            contentDiv.innerHTML = newHtml;
        }

        let childContainer = document.getElementById("children-" + item.id);
        if (item.hasChildren) {
            if (!childContainer) {
                childContainer = document.createElement("div");
                childContainer.id = "children-" + item.id;
                li.appendChild(childContainer);

                if (item.expanded) {
                    requestChildren(item);
                }
            } else {
                if (item.expanded) {
                    requestChildren(item);
                }
            }
        } else {
            if (childContainer) childContainer.remove();
        }

        ul.appendChild(li);
    });

    existingLiMap.forEach((li, id) => {
        if (!keepIds.has(id)) {
            li.remove();
            itemMap.delete(id);
            selectedIds.delete(id);
        }
    });
    updateBatchDeleteButton();
}

function setBatchMode(enabled) {
    batchMode = Boolean(enabled);
    const toolbar = document.getElementById("batch-toolbar");
    toolbar.hidden = !batchMode;
    if (!batchMode) {
        selectedIds.clear();
        showBatchStatus("");
    }
    updateBatchDeleteButton();
    requestChildren();
    if (batchMode) {
        document.getElementById("batch-input").focus();
    }
}

function showBatchStatus(message) {
    document.getElementById("batch-status").textContent = message || "";
}

function getPendingExpressions() {
    const expressions = [];
    const seen = new Set();
    for (const line of document.getElementById("batch-input").value.split(/\r?\n/)) {
        const expression = line.trim();
        if (expression && !seen.has(expression)) {
            seen.add(expression);
            expressions.push(expression);
        }
    }
    return expressions;
}

function renderPendingExpressions() {
    const expressions = getPendingExpressions();
    const nextExpressions = new Set(expressions);
    for (const expression of selectedPendingExpressions) {
        if (!nextExpressions.has(expression)) {
            selectedPendingExpressions.delete(expression);
        }
    }
    for (const expression of expressions) {
        if (!pendingExpressions.has(expression)) {
            selectedPendingExpressions.add(expression);
        }
    }
    pendingExpressions = nextExpressions;

    const container = document.getElementById("batch-add-list");
    container.replaceChildren();
    for (const expression of expressions) {
        const label = document.createElement("label");
        label.className = "batch-add-item";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedPendingExpressions.has(expression);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                selectedPendingExpressions.add(expression);
            } else {
                selectedPendingExpressions.delete(expression);
            }
            updateBatchAddButton();
        });
        const text = document.createElement("span");
        text.textContent = expression;
        label.append(checkbox, text);
        container.appendChild(label);
    }
    updateBatchAddButton();
}

function updateBatchAddButton() {
    const button = document.getElementById("batch-add");
    const count = selectedPendingExpressions.size;
    button.disabled = count === 0;
    button.textContent = count > 0 ? `Add selected (${count})` : "Add selected";
}

function updateBatchDeleteButton() {
    const button = document.getElementById("batch-delete");
    button.disabled = selectedIds.size === 0;
    button.textContent = selectedIds.size > 0 ? `Remove selected (${selectedIds.size})` : "Remove selected";
}

window.toggleBatchSelection = (event, id) => {
    event.stopPropagation();
    if (event.target.checked) {
        selectedIds.add(id);
    } else {
        selectedIds.delete(id);
    }
    updateBatchDeleteButton();
};

document.getElementById("batch-add").addEventListener("click", () => {
    const expressions = getPendingExpressions().filter((expression) => selectedPendingExpressions.has(expression));
    if (expressions.length > 0) {
        vscode.postMessage({ type: "addMany", value: expressions.join("\n") });
    }
});

document.getElementById("batch-input").addEventListener("input", renderPendingExpressions);

document.getElementById("batch-select-all").addEventListener("click", () => {
    const checkboxes = Array.from(document.querySelectorAll("#tree-root > ul > li > .tree-content > .batch-checkbox"));
    const selectAll = checkboxes.some((checkbox) => !checkbox.checked);
    for (const checkbox of checkboxes) {
        checkbox.checked = selectAll;
        const li = checkbox.closest("li[data-id]");
        if (!li) continue;
        if (selectAll) {
            selectedIds.add(li.dataset.id);
        } else {
            selectedIds.delete(li.dataset.id);
        }
    }
    updateBatchDeleteButton();
});

document.getElementById("batch-delete").addEventListener("click", () => {
    const items = Array.from(selectedIds, (id) => ({ id }));
    if (items.length > 0) {
        vscode.postMessage({ type: "deleteMany", items });
    }
});

document.getElementById("batch-done").addEventListener("click", () => {
    setBatchMode(false);
    vscode.postMessage({ type: "batchModeChanged", enabled: false });
});

window.startEdit = (element, id, field) => {
    let currentVal = element.innerText;
    if (field === "value") {
        const item = itemMap.get(id);
        if (item && item.actualValue !== undefined) {
            currentVal = item.actualValue;
        }
    }
    vscode.postMessage({ type: "beginEdit", item: { id }, field: field, value: currentVal });
};

window.selectFormat = (event, id) => {
    event.stopPropagation();

    const existing = document.querySelector(".context-menu");
    if (existing) existing.remove();

    const menu = document.createElement("div");
    menu.className = "context-menu";

    const formats = [
        { label: "Natural", value: "natural" },
        { label: "Decimal", value: "decimal" },
        { label: "Hex", value: "hex" },
        { label: "Octal", value: "octal" },
        { label: "Binary", value: "binary" },
    ];

    formats.forEach((fmt) => {
        const item = document.createElement("div");
        item.className = "context-menu-item";
        item.innerText = fmt.label;
        item.onclick = () => {
            vscode.postMessage({ type: "setFormat", item: { id }, format: fmt.value });
            menu.remove();
        };
        menu.appendChild(item);
    });

    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;

    if (x + rect.width > window.innerWidth) {
        x = window.innerWidth - rect.width;
    }
    if (y + rect.height > window.innerHeight) {
        y = window.innerHeight - rect.height;
    }

    menu.style.left = x + "px";
    menu.style.top = y + "px";

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener("click", closeMenu);
            document.removeEventListener("contextmenu", closeMenu);
        }
    };

    setTimeout(() => {
        document.addEventListener("click", closeMenu);
        document.addEventListener("contextmenu", closeMenu);
    }, 0);
};

function startAdd() {
    vscode.postMessage({ type: "addRequested" });
}

window.editLabel = (event, id) => {
    event.stopPropagation();
    const treeContent = event.target.closest(".tree-content");
    const labelSpan = treeContent.querySelector(".label");
    if (labelSpan) {
        startEdit(labelSpan, id, "label");
    }
};

window.editValue = (event, id) => {
    event.stopPropagation();
    const treeContent = event.target.closest(".tree-content");
    const valueSpan = treeContent.querySelector(".value");
    if (valueSpan) {
        startEdit(valueSpan, id, "value");
    }
};

window.toggleExpand = (e, id) => {
    e.stopPropagation();
    const item = itemMap.get(id);
    const chevron = e.target;
    if (item.expanded) {
        item.expanded = false;
        chevron.classList.remove("codicon-chevron-down");
        chevron.classList.add("codicon-chevron-right");
        const container = document.getElementById("children-" + id);
        if (container) container.innerHTML = "";
        vscode.postMessage({ type: "setExpanded", item: { id }, expanded: false });
    } else {
        item.expanded = true;
        chevron.classList.remove("codicon-chevron-right");
        chevron.classList.add("codicon-chevron-down");
        vscode.postMessage({ type: "setExpanded", item: { id }, expanded: true });
        requestChildren(item);
    }
};

window.moveUp = (e, id) => {
    e.stopPropagation();
    vscode.postMessage({ type: "moveUp", item: { id } });
};

window.moveDown = (e, id) => {
    e.stopPropagation();
    vscode.postMessage({ type: "moveDown", item: { id } });
};

window.deleteItem = (e, id) => {
    e.stopPropagation();
    vscode.postMessage({ type: "delete", item: { id } });
};

requestChildren();

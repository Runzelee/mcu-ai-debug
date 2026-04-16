const vscode = acquireVsCodeApi();
const itemMap = new Map();

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
        return `<span class="dummy-msg">${item.label}</span>`;
    }
    let actionsHtml = "";
    let editValueButton = `<span class="codicon codicon-edit-sparkle" onclick="editValue(event, '${item.id}')" title="Edit Value"></span>\n`;
    let editValueText = `<span class="value ${item.changed ? "changed" : ""}" ondblclick="startEdit(this, '${item.id}', 'value')">${item.value || ""}</span>\n`;
    let editLabelText = `<span class="label" ondblclick="startEdit(this, '${item.id}', 'label')">${item.label}</span>\n`;
    if (item.hasChildren || item.readonly) {
        editValueButton = "";
        if (item.readonly) {
            editValueText = `<span class="value readonly ${item.changed ? "changed" : ""}">${item.value || ""}</span>\n`;
        } else {
            editValueText = `<span class="value ${item.changed ? "changed" : ""}">${item.value || ""}</span>\n`;
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
        editLabelText = `<span class="label">${item.label}</span>\n`;
        actionsHtml = `
            <div class="actions">
                ${editValueButton}
                ${hexFormat}
            </div>
        `;
    }
    if (!isTopLevel) {
        editLabelText = `<span class="label">${item.label}</span>\n`;
        actionsHtml = `
            <div class="actions">
                ${editValueButton}
                ${hexFormat}
            </div>
        `;
    }

    const chevronClass = item.expanded ? "codicon-chevron-down" : "codicon-chevron-right";
    const labelEscaped = (item.contextValue || "").replace(/"/g, "&quot;");
    const valueEscaped = (item.value || "").replace(/"/g, "&quot;");
    const editLabelWithTitle = editLabelText.replace(/(<span class="label"[^>]*>)/, `$1<span title="${labelEscaped}">`);
    const editValueWithTitle = editValueText.replace(/(<span class="value[^"]*"[^>]*>)/, `$1<span title="${valueEscaped}">`);
    return `
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
        if (!keepIds.has(id)) li.remove();
    });
}

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

// ==UserScript==
// @name         Alta Prior Liability + Rated Drivers
// @namespace    https://tampermonkey.net/
// @version      6.0
// @description  Shows active prior liability and rated driver DOBs in a movable box
// @match        https://alta.farmers.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SCAN_INTERVAL = 2000;
    const BOX_ID = 'alta-prior-liability-box';

    let currentCustomer = '';
    let currentBI = '';
    let currentPD = '';
    let currentDrivers = [];

    let lastCustomer = '';
    let lastBI = '';
    let lastPD = '';
    let lastDriversJSON = '';

    let boxClosed = false;

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeName(name) {
        return normalizeText(name).toLowerCase();
    }

    function isVisible(element) {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
               style.visibility !== 'hidden' &&
               rect.width > 0 &&
               rect.height > 0;
    }

    function findCustomerName() {
        if (!document.body) return null;

        const lines = (document.body.innerText || '')
            .split('\n')
            .map(normalizeText)
            .filter(Boolean);

        for (const line of lines) {
            const match = line.match(/^(.+?)\s*-\s*Auto$/i);
            if (!match) continue;

            let name = normalizeText(match[1])
                .replace(/^(circle|radio|button|select)\s+/i, '');

            if (name.length >= 3 &&
                name.length <= 100 &&
                !/^(drivers|customer|prior insurance)$/i.test(name)) {
                return name;
            }
        }

        return null;
    }

    function findActivePolicyCard() {
        const elements = Array.from(document.querySelectorAll('body *'));

        for (const element of elements) {
            if (!isVisible(element)) continue;

            const text = normalizeText(
                element.innerText || element.textContent || ''
            );

            if (text.length < 20 || text.length > 2500) continue;
            if (!/\bIn Effect\b/i.test(text)) continue;
            if (/\bCancelled\b/i.test(text)) continue;
            if (/\bProvided by agent\b/i.test(text)) continue;
            if (!/\bBI\b/i.test(text) && !/\bPD\b/i.test(text)) continue;

            let candidate = element;
            let parent = element.parentElement;

            for (let i = 0; i < 8 && parent; i++) {
                const parentText = normalizeText(
                    parent.innerText || parent.textContent || ''
                );

                if (parentText.length <= 2500 &&
                    /\bIn Effect\b/i.test(parentText) &&
                    (/\bBI\b/i.test(parentText) || /\bPD\b/i.test(parentText))) {
                    candidate = parent;
                    parent = parent.parentElement;
                } else {
                    break;
                }
            }

            return candidate;
        }

        return null;
    }

    function findLiability() {
        const card = findActivePolicyCard();

        if (!card) return { bi: '', pd: '' };

        const text = normalizeText(
            card.innerText || card.textContent || ''
        );

        const biMatch = text.match(
            /\bBI\b[\s:]*\$?\s*([\d,]+)\s*\/\s*\$?\s*([\d,]+)/i
        );

        const pdMatch = text.match(
            /\bPD\b[\s:]*\$?\s*([\d,]+)/i
        );

        return {
            bi: biMatch ? `$${biMatch[1]} / $${biMatch[2]}` : '',
            pd: pdMatch ? `$${pdMatch[1]}` : ''
        };
    }

    function findRatedDriversSection() {
        const elements = Array.from(document.querySelectorAll('body *'));

        for (const element of elements) {
            if (!isVisible(element)) continue;

            const text = normalizeText(
                element.innerText || element.textContent || ''
            );

            if (/^Rated drivers\s*\(\d+\)/i.test(text)) {
                return element;
            }
        }

        for (const element of elements) {
            if (!isVisible(element)) continue;

            const text = normalizeText(
                element.innerText || element.textContent || ''
            );

            if (/^Rated drivers\b/i.test(text) && /\(\d+\)/.test(text)) {
                return element;
            }
        }

        return null;
    }

    function findRatedDrivers() {
        const section = findRatedDriversSection();
        if (!section) return [];

        let container = section.parentElement;
        if (!container) return [];

        const inputs = Array.from(container.querySelectorAll('input'))
            .filter(isVisible)
            .filter(input => {
                const type = (input.type || '').toLowerCase();
                return type !== 'hidden' &&
                       type !== 'checkbox' &&
                       type !== 'radio';
            });

        if (!inputs.length) return [];

        const columns = [];

        for (const input of inputs) {
            const rect = input.getBoundingClientRect();
            const x = Math.round(rect.left / 25) * 25;

            let column = columns.find(c => Math.abs(c.x - x) <= 25);

            if (!column) {
                column = { x, inputs: [] };
                columns.push(column);
            }

            column.inputs.push({
                element: input,
                top: rect.top
            });
        }

        columns.sort((a, b) => a.x - b.x);

        const drivers = [];

        for (const column of columns) {
            column.inputs.sort((a, b) => a.top - b.top);

            if (column.inputs.length < 3) continue;

            const firstThree = column.inputs.slice(0, 3).map(x => x.element);

            const firstName = normalizeText(firstThree[0].value);
            const lastName = normalizeText(firstThree[1].value);
            const dob = normalizeText(firstThree[2].value);

            if (!firstName || !lastName || !dob) continue;
            if (firstName.length > 50 || lastName.length > 50) continue;
            if (!/\d/.test(dob)) continue;

            drivers.push({ firstName, lastName, dob });
        }

        const unique = [];
        const seen = new Set();

        for (const driver of drivers) {
            const key = normalizeName(
                `${driver.firstName} ${driver.lastName} ${driver.dob}`
            );

            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(driver);
        }

        return unique;
    }

    function escapeHTML(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function createBox() {
        if (document.getElementById(BOX_ID)) return;

        const box = document.createElement('div');
        box.id = BOX_ID;

        box.innerHTML = `
            <div id="alta-liability-header">
                <span>PRIOR LIABILITY</span>
                <div>
                    <button id="alta-minimize" type="button">−</button>
                    <button id="alta-close" type="button">×</button>
                </div>
            </div>

            <div id="alta-liability-content">
                <div id="alta-customer">Customer: Detecting...</div>

                <div id="alta-policy-section">
                    <div class="alta-value">
                        <span>BI:</span>
                        <strong id="alta-bi">--</strong>
                    </div>

                    <div class="alta-value">
                        <span>PD:</span>
                        <strong id="alta-pd">--</strong>
                    </div>
                </div>

                <div id="alta-drivers-title">RATED DRIVERS</div>
                <div id="alta-drivers">Waiting for rated drivers...</div>
                <div id="alta-status">Waiting...</div>
            </div>
        `;

        document.body.appendChild(box);

        const style = document.createElement('style');
        style.id = 'alta-liability-style';

        style.textContent = `
            #${BOX_ID} {
                position: fixed;
                top: 90px;
                right: 20px;
                width: 310px;
                max-height: 80vh;
                background: #fff;
                color: #222;
                border: 2px solid #16852b;
                border-radius: 9px;
                box-shadow: 0 4px 18px rgba(0,0,0,.28);
                z-index: 2147483647;
                font-family: Arial, Helvetica, sans-serif;
                overflow: hidden;
                user-select: none;
            }

            #alta-liability-header {
                height: 34px;
                background: #16852b;
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 8px;
                font-size: 12px;
                font-weight: bold;
                cursor: grab;
                touch-action: none;
            }

            #alta-liability-header:active { cursor: grabbing; }

            #alta-liability-header button {
                width: 22px;
                height: 25px;
                border: none;
                background: transparent;
                color: #fff;
                font-size: 18px;
                font-weight: bold;
                cursor: pointer;
                padding: 0;
            }

            #alta-liability-header button:hover {
                background: rgba(255,255,255,.15);
                border-radius: 3px;
            }

            #alta-liability-content {
                padding: 12px;
                max-height: calc(80vh - 34px);
                overflow-y: auto;
            }

            #alta-customer {
                font-size: 12px;
                font-weight: bold;
                color: #555;
                margin-bottom: 12px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .alta-value {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 16px;
                margin-bottom: 8px;
            }

            .alta-value span { width: 28px; }
            .alta-value strong { font-weight: bold; }

            #alta-drivers-title {
                border-top: 1px solid #ddd;
                margin-top: 12px;
                padding-top: 10px;
                font-size: 11px;
                font-weight: bold;
                color: #555;
            }

            .alta-driver {
                padding: 8px 0;
                border-bottom: 1px solid #eee;
                font-size: 12px;
            }

            .alta-driver-name {
                font-weight: bold;
                margin-bottom: 4px;
            }

            .alta-driver-dob { color: #555; }

            #alta-status {
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px solid #ddd;
                font-size: 10px;
                color: #666;
            }
        `;

        document.head.appendChild(style);

        document.getElementById('alta-minimize').addEventListener('click', e => {
            e.stopPropagation();
            const content = document.getElementById('alta-liability-content');
            const button = document.getElementById('alta-minimize');

            if (content.style.display === 'none') {
                content.style.display = 'block';
                button.textContent = '−';
            } else {
                content.style.display = 'none';
                button.textContent = '+';
            }
        });

        document.getElementById('alta-close').addEventListener('click', e => {
            e.stopPropagation();
            box.remove();
            boxClosed = true;
        });

        const header = document.getElementById('alta-liability-header');

        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        header.addEventListener('pointerdown', event => {
            if (event.target.tagName === 'BUTTON') return;

            dragging = true;

            const rect = box.getBoundingClientRect();

            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            box.style.left = startLeft + 'px';
            box.style.top = startTop + 'px';
            box.style.right = 'auto';

            header.setPointerCapture(event.pointerId);
            event.preventDefault();
        });

        header.addEventListener('pointermove', event => {
            if (!dragging) return;

            const newLeft = startLeft + event.clientX - startX;
            const newTop = startTop + event.clientY - startY;

            const maxLeft = Math.max(0, window.innerWidth - box.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - box.offsetHeight);

            box.style.left =
                Math.max(0, Math.min(newLeft, maxLeft)) + 'px';

            box.style.top =
                Math.max(0, Math.min(newTop, maxTop)) + 'px';

            event.preventDefault();
        });

        header.addEventListener('pointerup', event => {
            dragging = false;
            try {
                header.releasePointerCapture(event.pointerId);
            } catch (e) {}
        });

        header.addEventListener('pointercancel', () => {
            dragging = false;
        });
    }

    function updateBox() {
        if (boxClosed) return;

        createBox();

        const customer = document.getElementById('alta-customer');
        const bi = document.getElementById('alta-bi');
        const pd = document.getElementById('alta-pd');
        const drivers = document.getElementById('alta-drivers');
        const status = document.getElementById('alta-status');

        if (!customer) return;

        customer.textContent =
            currentCustomer
                ? `Customer: ${currentCustomer}`
                : 'Customer: Detecting...';

        bi.textContent = currentBI || '--';
        pd.textContent = currentPD || '--';

        if (!currentDrivers.length) {
            drivers.innerHTML = 'No rated drivers detected.';
        } else {
            drivers.innerHTML = currentDrivers.map((driver, index) => `
                <div class="alta-driver">
                    <div class="alta-driver-name">
                        ${index + 1}. ${escapeHTML(driver.firstName)}
                        ${escapeHTML(driver.lastName)}
                    </div>
                    <div class="alta-driver-dob">
                        DOB: ${escapeHTML(driver.dob)}
                    </div>
                </div>
            `).join('');
        }

        status.textContent =
            (currentBI || currentPD || currentDrivers.length)
                ? 'Information detected'
                : 'Waiting for information...';
    }

    function scan() {
        if (!document.body || boxClosed) return;

        const detectedCustomer = findCustomerName();

        if (detectedCustomer) {
            if (
                currentCustomer &&
                normalizeName(detectedCustomer) !== normalizeName(currentCustomer)
            ) {
                currentCustomer = detectedCustomer;
                currentBI = '';
                currentPD = '';
                currentDrivers = [];

                lastCustomer = '';
                lastBI = '';
                lastPD = '';
                lastDriversJSON = '';
            }

            if (!currentCustomer) {
                currentCustomer = detectedCustomer;
            }
        }

        const liability = findLiability();

        if (liability.bi) currentBI = liability.bi;
        if (liability.pd) currentPD = liability.pd;

        const ratedDrivers = findRatedDrivers();

        if (ratedDrivers.length > 0) {
            currentDrivers = ratedDrivers;
        }

        const driversJSON = JSON.stringify(currentDrivers);

        if (
            currentCustomer !== lastCustomer ||
            currentBI !== lastBI ||
            currentPD !== lastPD ||
            driversJSON !== lastDriversJSON
        ) {
            updateBox();

            lastCustomer = currentCustomer;
            lastBI = currentBI;
            lastPD = currentPD;
            lastDriversJSON = driversJSON;
        }
    }

    function start() {
        createBox();
        scan();
        setInterval(scan, SCAN_INTERVAL);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();

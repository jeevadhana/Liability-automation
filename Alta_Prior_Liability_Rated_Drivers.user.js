// ==UserScript==
// @name         Alta Prior Liability + Rated Drivers
// @namespace    https://tampermonkey.net/
// @version      6.7
// @description  Highlights carrier and makes BI/PD limits larger and easier to read
// @match        https://alta.farmers.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SCAN_INTERVAL = 2000;
    const BOX_ID = 'alta-prior-liability-box';

    let currentCustomer = '';
    let currentCarrier = '';
    let currentBI = '';
    let currentPD = '';
    let currentDrivers = [];

    let lastCustomer = '';
    let lastCarrier = '';
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
        // The customer label is in Alta's left navigation, e.g.
        // "Sylvia Lopez - Auto + Home". Do not depend on body.innerText
        // line breaks: Alta may combine neighboring sidebar text into one line.
        const pattern = /([\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){1,3})\s*-\s*Auto(?:\s*\+\s*Home)?\b/i;
        const candidates = Array.from(document.querySelectorAll(
            'a, button, span, p, div, li, h1, h2, h3'
        )).filter(isVisible).map(element => ({
            element,
            text: normalizeText(element.innerText || element.textContent || '')
        })).filter(item => item.text && item.text.length <= 120 && pattern.test(item.text));

        // Prefer the smallest matching element so a whole navigation panel
        // cannot accidentally be interpreted as the customer label.
        candidates.sort((a, b) => a.text.length - b.text.length);
        for (const item of candidates) {
            const match = item.text.match(pattern);
            if (match) {
                const name = normalizeText(match[1]);
                if (name.split(/\s+/).length >= 2) return name;
            }
        }

        // Fallback: inspect individual visible text nodes, including labels
        // whose parent combines the customer name with other sidebar text.
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!normalizeText(node.nodeValue)) continue;
            const parent = node.parentElement;
            if (!isVisible(parent)) continue;
            const match = normalizeText(node.nodeValue).match(pattern);
            if (match) return normalizeText(match[1]);
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

    if (!card) {
        return {
            carrier: '',
            bi: '',
            pd: ''
        };
    }

    const rawText = String(
        card.innerText || card.textContent || ''
    );

    const text = normalizeText(rawText);

    // Read the carrier from the policy-card line that contains
    // "In Effect", rather than from the whole section heading.
    const carrierLine = rawText
        .split(/\r?\n/)
        .map(normalizeText)
        .find(line => /\bIn Effect\b/i.test(line));

    const carrierMatch = carrierLine
        ? carrierLine.match(/^(.+?)\s+In Effect\b/i)
        : null;

    const biMatch = text.match(
        /\bBI\b[\s:]*\$?\s*([\d,]+)\s*\/\s*\$?\s*([\d,]+)/i
    );

    const pdMatch = text.match(
        /\bPD\b[\s:]*\$?\s*([\d,]+)/i
    );

    return {
        carrier: carrierMatch ? carrierMatch[1].trim() : '',
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

    // The Alta page lays each rated driver out in a separate vertical column.
    // Include native selects and custom Angular/ARIA dropdown controls.
    let container = section.parentElement;
    for (let i = 0; i < 4 && container?.parentElement; i++) {
        const text = normalizeText(container.innerText || '');
        if (/First name/i.test(text) && /Date of birth/i.test(text)) break;
        container = container.parentElement;
    }

    const selector = 'input, select, textarea, [role="combobox"], [aria-haspopup="listbox"]';
    const controls = Array.from(container.querySelectorAll(selector)).filter(el => {
        if (!isVisible(el)) return false;
        const type = (el.type || '').toLowerCase();
        return !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type);
    });

    const columns = [];
    for (const el of controls) {
        const r = el.getBoundingClientRect();
        let col = columns.find(c => Math.abs(c.x - r.left) < 45);
        if (!col) { col = { x: r.left, items: [] }; columns.push(col); }
        col.items.push({ el, top: r.top });
    }

    function valueOf(el) {
        if (!el) return '';
        if (el.tagName === 'SELECT') {
            return normalizeText(el.selectedOptions?.[0]?.textContent || el.value);
        }
        const direct = normalizeText(el.value || el.getAttribute('aria-valuetext') || el.innerText || el.textContent || '');
        if (direct) return direct;
        const labelled = el.getAttribute('aria-label') || el.getAttribute('title');
        return normalizeText(labelled || '');
    }

    const drivers = [];
    for (const col of columns) {
        col.items.sort((a, b) => a.top - b.top);
        const items = col.items;
        const firstName = valueOf(items[0]?.el);
        const lastName = valueOf(items[1]?.el);
        const dob = valueOf(items[2]?.el);
        if (!firstName || !lastName || !dob || !/\d/.test(dob)) continue;
        if (firstName.length > 50 || lastName.length > 50) continue;

        // On Alta, after First name, Last name and DOB, the next four
        // controls are Driver status, Gender, Relationship to PNI, Marital status.
        const later = items.slice(3).map(item => ({ top: item.top, value: valueOf(item.el) })).filter(x => x.value);
        const relationship = later.length >= 3 ? later[2].value : '';
        const maritalStatus = later.length >= 4 ? later[3].value : '';

        drivers.push({ firstName, lastName, dob, relationship, maritalStatus });
    }

    // Fallback: extract the visible dropdown text by the Alta row labels
    // when custom dropdowns are not exposed as form controls.
    if (drivers.some(d => !d.relationship || !d.maritalStatus)) {
        const labels = Array.from(container.querySelectorAll('label, div, span'))
            .filter(isVisible)
            .filter(el => {
                const t = normalizeText(el.textContent || '');
                return t === 'Relationship to PNI' || t === 'Marital status';
            });
        for (const label of labels) {
            const row = label.parentElement;
            if (!row) continue;
            const rowText = normalizeText(row.innerText || '');
            const match = rowText.match(/Relationship to PNI\s*(Self|Spouse\/DP|Child|Other)/i) ||
                          rowText.match(/Marital status\s*(Married|Single|Divorced|Widowed)/i);
            if (!match) continue;
            const val = normalizeText(match[1]);
            const y = label.getBoundingClientRect().top;
            for (const d of drivers) {
                const idx = drivers.indexOf(d);
                const col = columns[idx];
                if (!col) continue;
                const x = col.x;
                const nearby = Array.from(row.querySelectorAll('*')).some(el => {
                    const r = el.getBoundingClientRect();
                    return Math.abs(r.left - x) < 80 && r.width > 20;
                });
                if (nearby) {
                    if (/^Relationship/i.test(rowText)) d.relationship = val;
                    else d.maritalStatus = val;
                }
            }
        }
    }

    const unique = [];
    const seen = new Set();
    for (const driver of drivers) {
        const key = normalizeName(`${driver.firstName} ${driver.lastName} ${driver.dob}`);
        if (!seen.has(key)) { seen.add(key); unique.push(driver); }
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
                <div id="alta-carrier">Carrier: --</div>

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

                <div id="alta-pni-alert" style="display:none;">DO SWAP PNI</div>
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
                right: 18px;
                width: 370px;
                max-width: calc(100vw - 24px);
                background: #fff;
                color: #222;
                border: 1px solid #16852b;
                border-radius: 8px;
                box-shadow: 0 3px 14px rgba(0,0,0,.22);
                z-index: 2147483647;
                font-family: Arial, Helvetica, sans-serif;
                overflow: hidden;
                user-select: none;
            }

            #alta-liability-header {
                height: 28px;
                background: #16852b;
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 7px;
                font-size: 15px !important;
                font-weight: bold;
                cursor: grab;
                touch-action: none;
            }

            #alta-liability-header:active { cursor: grabbing; }

            #alta-liability-header button {
                width: 20px;
                height: 23px;
                border: none;
                background: transparent;
                color: #fff;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                padding: 0;
            }

            #alta-liability-header button:hover {
                background: rgba(255,255,255,.15);
                border-radius: 3px;
            }

            #alta-liability-content {
                padding: 8px;
                max-height: none !important;
                height: auto !important;
                overflow: visible !important;
            }

            #alta-customer {
                font-size: 12px;
                font-weight: bold;
                color: #555;
                margin-bottom: 3px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            #alta-carrier {
                display: block;
                box-sizing: border-box;
                font-size: 20px !important;
                font-weight: 800 !important;
                color: #0757b7 !important;
                background: #eaf3ff !important;
                border-left: 4px solid #0757b7 !important;
                border-radius: 4px;
                padding: 5px 8px !important;
                margin: 5px 0 8px !important;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            #alta-policy-section {
                display: flex;
                align-items: center;
                gap: 14px;
                padding: 5px 0;
                border-top: 1px solid #e5e5e5;
                border-bottom: 1px solid #e5e5e5;
            }

            .alta-value {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 12px;
                margin: 0;
                white-space: nowrap;
            }

            .alta-value span { color: #555; }
            .alta-value strong { font-weight: bold; }

            #alta-pni-alert {
                margin-top: 6px;
                padding: 4px 6px;
                background: #d90000 !important;
                border: 2px solid #a80000 !important;
                border-radius: 5px;
                color: #ffffff !important;
                font-size: 15px !important;
                font-weight: bold;
                text-align: center;
            }

            #alta-drivers-title {
                margin-top: 7px;
                margin-bottom: 4px;
                font-size: 10px;
                font-weight: bold;
                color: #555;
            }

            #alta-drivers {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 5px;
            }

            .alta-driver {
                min-width: 0;
                padding: 5px;
                background: #f5f7f8;
                border: 1px solid #e5e8ea;
                border-radius: 4px;
                font-size: 11px;
                overflow-wrap: anywhere;
            }

            .alta-driver-name {
                font-weight: bold;
                margin-bottom: 3px;
            }

            .alta-driver-detail {
                color: #555;
                font-size: 11px;
                line-height: 1.4;
            }

            /* Force readable text sizes even if Alta page styles interfere. */
            #${BOX_ID}, #${BOX_ID} * {
                font-family: Arial, Helvetica, sans-serif !important;
                font-size: 14px !important;
                line-height: 1.35 !important;
            }
            #alta-liability-header { font-size: 15px !important; }
            #alta-customer { font-size: 15px !important; }
            #alta-carrier { font-size: 20px !important; color: #0757b7 !important; }
            /* Slightly enlarge BI and PD labels and limits. */
            #alta-policy-section {
                gap: 16px !important;
                padding: 7px 0 !important;
            }
            #alta-policy-section .alta-value {
                font-size: 15px !important;
                gap: 5px !important;
            }
            #alta-policy-section .alta-value span {
                font-size: 14px !important;
                font-weight: 700 !important;
                color: #333 !important;
            }
            #alta-policy-section .alta-value strong {
                font-size: 15px !important;
                font-weight: 800 !important;
                color: #111 !important;
            }
            #alta-drivers-title { font-size: 13px !important; }
            .alta-driver-name { font-size: 14px !important; }
            .alta-driver-detail { font-size: 13px !important; }
            #alta-pni-alert {
                display: none;
                background: #d90000 !important;
                color: #fff !important;
                border: 2px solid #a80000 !important;
                font-size: 16px !important;
                font-weight: 900 !important;
                padding: 7px !important;
                text-align: center !important;
            }

            #alta-status {
                margin-top: 6px;
                padding-top: 5px;
                border-top: 1px solid #e5e5e5;
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

    function shouldSwapPNI(drivers) {
        const isMarried = driver =>
            /\bmarried\b/i.test(normalizeText(driver.maritalStatus));

        const isSelf = driver =>
            /^self$/i.test(normalizeText(driver.relationship));

        const isSpouse = driver =>
            /spouse|\bdp\b/i.test(normalizeText(driver.relationship));

        return drivers.some(selfDriver =>
            isSelf(selfDriver) &&
            isMarried(selfDriver) &&
            drivers.some(spouseDriver =>
                spouseDriver !== selfDriver &&
                isSpouse(spouseDriver) &&
                isMarried(spouseDriver)
            )
        );
    }

    function updateBox() {
        if (boxClosed) return;

        createBox();

        const customer = document.getElementById('alta-customer');
        const carrier = document.getElementById('alta-carrier');
        const bi = document.getElementById('alta-bi');
        const pd = document.getElementById('alta-pd');
        const drivers = document.getElementById('alta-drivers');
        const status = document.getElementById('alta-status');
        const pniAlert = document.getElementById('alta-pni-alert');

        if (!customer) return;

        customer.textContent = currentCustomer
            ? `Customer: ${currentCustomer}`
            : 'Customer: Detecting...';

        carrier.textContent = `Carrier: ${currentCarrier || '--'}`;
        bi.textContent = currentBI || '--';
        pd.textContent = currentPD || '--';

        if (!currentDrivers.length) {
            drivers.innerHTML = '<div class="alta-driver">No rated drivers detected.</div>';
        } else {
            drivers.innerHTML = currentDrivers.map((driver, index) => `
                <div class="alta-driver">
                    <div class="alta-driver-name">
                        ${index + 1}. ${escapeHTML(driver.firstName)} ${escapeHTML(driver.lastName)}
                    </div>
                    <div class="alta-driver-detail">DOB: ${escapeHTML(driver.dob)}</div>
                    <div class="alta-driver-detail">PNI: ${escapeHTML(driver.relationship || '--')}</div>
                    <div class="alta-driver-detail">Marital: ${escapeHTML(driver.maritalStatus || '--')}</div>
                </div>
            `).join('');
        }

        pniAlert.style.display = shouldSwapPNI(currentDrivers) ? 'block' : 'none';

        status.textContent =
            (currentCarrier || currentBI || currentPD || currentDrivers.length)
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
                currentCarrier = '';
                currentBI = '';
                currentPD = '';
                currentDrivers = [];

                lastCustomer = '';
                lastCarrier = '';
                lastBI = '';
                lastPD = '';
                lastDriversJSON = '';
            }

            if (!currentCustomer) {
                currentCustomer = detectedCustomer;
            }
        }

        const liability = findLiability();

        if (liability.carrier) currentCarrier = liability.carrier;
        if (liability.bi) currentBI = liability.bi;
        if (liability.pd) currentPD = liability.pd;

        const ratedDrivers = findRatedDrivers();

        if (ratedDrivers.length > 0) {
            currentDrivers = ratedDrivers;
        }

        const driversJSON = JSON.stringify(currentDrivers);

        if (
            currentCustomer !== lastCustomer ||
            currentCarrier !== lastCarrier ||
            currentBI !== lastBI ||
            currentPD !== lastPD ||
            driversJSON !== lastDriversJSON
        ) {
            updateBox();

            lastCustomer = currentCustomer;
            lastCarrier = currentCarrier;
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
